// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { IMAGE_BASELINE } from './baseline';
import { AI_PROVIDERS } from './catalog';
import { AiError, MAX_IMAGE_BYTES, SAFE_FETCH, type FetchLike } from './providers';
import { generateImage, type ImageRequest } from './send';

const KEY = 'sk-test-secret';
const PICTURE = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

/** What Venice sends with a picture it found nothing wrong with. */
const CHECKED_FINE = { 'x-venice-is-blurred': 'false', 'x-venice-is-content-violation': 'false' };

interface Recorded {
  url: string;
  init: RequestInit;
}

function fetchPicture(options: { status?: number; type?: string; headers?: Record<string, string>; body?: BodyInit | null } = {}): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      const body = options.body === undefined ? PICTURE : options.body;
      const headers = { 'Content-Type': options.type ?? 'image/webp', ...(options.headers ?? CHECKED_FINE) };
      return Promise.resolve(new Response(body, { status: options.status ?? 200, headers }));
    },
  };
}

function request(fetch: FetchLike, extra: Partial<ImageRequest> = {}): ImageRequest {
  return { provider: 'venice', model: 'image-model', prompt: 'חתול ג׳ינג׳י על סקייטבורד', apiKey: KEY, fetch, ...extra };
}

async function reasonOf(promise: Promise<unknown>): Promise<AiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AiError);
  return err as AiError;
}

describe('generateImage', () => {
  it('returns the picture as it came, with its type', async () => {
    const { fetch } = fetchPicture({ type: 'image/png; charset=binary' });
    const image = await generateImage(request(fetch));
    expect(image.type).toBe('image/png');
    expect(new Uint8Array(image.bytes)).toEqual(PICTURE);
  });

  it('sends only what she asked for and the child-safety line, with safe mode on, to the picture endpoint only', async () => {
    const { fetch, calls } = fetchPicture();
    await generateImage(request(fetch));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(AI_PROVIDERS.venice.endpoints.image);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toEqual({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
    expect(calls[0].init).toMatchObject(SAFE_FETCH);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      model: 'image-model',
      prompt: `חתול ג׳ינג׳י על סקייטבורד\n\n${IMAGE_BASELINE}`,
      safe_mode: true,
      return_binary: true,
      format: 'webp',
    });
    expect(IMAGE_BASELINE).toMatch(/safe for children/);
  });

  it.each(['x-venice-is-blurred', 'x-venice-is-content-violation'])('never hands over a picture the provider marked with %s', async (header) => {
    const { fetch } = fetchPicture({ headers: { ...CHECKED_FINE, [header]: 'true' } });
    expect((await reasonOf(generateImage(request(fetch)))).reason).toBe('refused');
  });

  it('takes a picture only when both marks say it is fine', async () => {
    const { fetch } = fetchPicture({ headers: CHECKED_FINE });
    await expect(generateImage(request(fetch))).resolves.toMatchObject({ type: 'image/webp' });
  });

  it.each([
    ['both marks are missing (the page cannot read them)', {}],
    ['the blur mark is missing', { 'x-venice-is-content-violation': 'false' }],
    ['the violation mark is missing', { 'x-venice-is-blurred': 'false' }],
    ['a mark has a value it does not know', { 'x-venice-is-blurred': 'maybe', 'x-venice-is-content-violation': 'false' }],
  ])('never hands over a picture nobody could check: %s', async (_name, headers) => {
    const { fetch } = fetchPicture({ headers });
    const err = await reasonOf(generateImage(request(fetch)));
    expect(err.reason).toBe('refused');
  });

  it('says for the parent when the marks could not be read at all', async () => {
    const { fetch } = fetchPicture({ headers: {} });
    expect((await reasonOf(generateImage(request(fetch)))).detail).toBe('the picture safety headers could not be read');
  });

  it.each([
    [422, 'refused'],
    [401, 'unauthorized'],
    [402, 'no-credit'],
    [429, 'rate-limited'],
    [400, 'bad-request'],
    [503, 'provider-down'],
  ])('maps status %i to "%s"', async (status, reason) => {
    const { fetch } = fetchPicture({ status, type: 'application/json', body: JSON.stringify({ error: 'nope' }) });
    expect((await reasonOf(generateImage(request(fetch)))).reason).toBe(reason);
  });

  it("keeps the provider's message for the parent, without the key and without what she asked for", async () => {
    const { fetch } = fetchPicture({ status: 400, type: 'application/json', body: JSON.stringify({ error: `bad model for ${KEY}` }) });
    const err = await reasonOf(generateImage(request(fetch)));
    expect(err.detail).toBe('400 bad model for ••••');
    expect(`${err.message} ${err.detail}`).not.toContain('חתול');
  });

  it('refuses an answer that is not a picture, is empty, or is far too large', async () => {
    const page = fetchPicture({ type: 'text/html', body: '<html>' });
    expect((await reasonOf(generateImage(request(page.fetch)))).reason).toBe('bad-response');
    const svg = fetchPicture({ type: 'image/svg+xml', body: '<svg/>' });
    expect((await reasonOf(generateImage(request(svg.fetch)))).reason).toBe('bad-response');
    const empty = fetchPicture({ body: new Uint8Array(0) });
    expect((await reasonOf(generateImage(request(empty.fetch)))).reason).toBe('bad-response');
    const huge = fetchPicture({ body: new Uint8Array(MAX_IMAGE_BYTES + 1) });
    const err = await reasonOf(generateImage(request(huge.fetch)));
    expect(err.reason).toBe('bad-response');
    expect(err.detail).toBe('picture too large');
  });

  it('reports no answer at all as a network problem, without the failure text', async () => {
    const fetch: FetchLike = () => Promise.reject(new TypeError(`Load failed for ${KEY}`));
    const err = await reasonOf(generateImage(request(fetch)));
    expect(err.reason).toBe('network');
    expect(err.detail).toBe('TypeError');
  });

  it('stops when she presses stop, and gives up on a picture that never arrives', async () => {
    const hanging: FetchLike = (_url, init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const stop = new AbortController();
    const stopped = reasonOf(generateImage(request(hanging, { signal: stop.signal })));
    stop.abort();
    expect((await stopped).reason).toBe('cancelled');
    expect((await reasonOf(generateImage(request(hanging, { timeoutMs: 20 })))).reason).toBe('timeout');
  });

  it('makes no call without a key', async () => {
    const { fetch, calls } = fetchPicture();
    expect((await reasonOf(generateImage(request(fetch, { apiKey: '  ' })))).reason).toBe('unauthorized');
    expect(calls).toHaveLength(0);
  });

  it('still gives the right reason when the connection fails while a picture is being thrown away', async () => {
    // A body that is never finished and can't be cancelled, as on a connection that already broke.
    const unclosable = (chunk: Uint8Array) => {
      let sent = false;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return new Promise<void>(() => undefined);
          sent = true;
          controller.enqueue(chunk);
        },
        cancel() {
          throw new TypeError('Load failed');
        },
      });
    };
    const blurred = fetchPicture({ headers: { 'x-venice-is-blurred': 'true', 'x-venice-is-content-violation': 'false' }, body: unclosable(PICTURE) });
    expect((await reasonOf(generateImage(request(blurred.fetch)))).reason).toBe('refused');
    const page = fetchPicture({ type: 'text/html', body: unclosable(PICTURE) });
    expect((await reasonOf(generateImage(request(page.fetch)))).reason).toBe('bad-response');
    const huge = fetchPicture({ body: unclosable(new Uint8Array(MAX_IMAGE_BYTES + 1)) });
    const err = await reasonOf(generateImage(request(huge.fetch)));
    expect(err.reason).toBe('bad-response');
    expect(err.detail).toBe('picture too large');
  });
});
