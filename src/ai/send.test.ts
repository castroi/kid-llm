// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { BASELINE_PROMPT, SEARCH_BASELINE } from './baseline';
import { AI_PROVIDERS } from './catalog';
import { AiError, MAX_ANSWER_CHARS, MAX_ERROR_BODY_CHARS, SAFE_FETCH, type FetchLike } from './providers';
import { MAX_LINE_CHARS } from './sse';
import { checkConnection, sendChat, type ChatRequest } from './send';

const KEY = 'sk-test-secret';
const encoder = new TextEncoder();

/** One streamed piece of an answer, as the provider sends it. */
function piece(content: string, finish: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`;
}
const DONE = 'data: [DONE]\n\n';

interface StreamOptions {
  /** Keep the connection open after the parts, as a call that hangs does. */
  hang?: boolean;
  /** Break the connection after the parts. */
  drop?: boolean;
}

/** A streamed answer, one part per read. Like a real fetch, an abort breaks the stream. */
function streamed(parts: (string | Uint8Array)[], signal: AbortSignal | null | undefined, { hang, drop }: StreamOptions = {}): Response {
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < parts.length) {
        const part = parts[next++];
        controller.enqueue(typeof part === 'string' ? encoder.encode(part) : part);
      } else if (drop) {
        controller.error(new TypeError('Load failed'));
      } else if (hang) {
        // Never answers again; a rejected pull breaks the stream, as an aborted fetch does.
        return new Promise<void>((_, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      } else {
        controller.close();
      }
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

interface Recorded {
  url: string;
  init: RequestInit;
}

function fetchStream(parts: (string | Uint8Array)[], options?: StreamOptions): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(streamed(parts, init.signal, options));
    },
  };
}

function fetchJson(status: number, body: unknown): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
    },
  };
}

function request(fetch: FetchLike, extra: Partial<ChatRequest> = {}): ChatRequest & { deltas: string[] } {
  const deltas: string[] = [];
  return {
    provider: 'venice',
    model: 'some-model',
    systemPrompt: 'Answer in simple Hebrew.',
    messages: [{ role: 'user', content: 'שלום' }],
    apiKey: KEY,
    onDelta: (text) => deltas.push(text),
    fetch,
    deltas,
    ...extra,
  };
}

async function reasonOf(promise: Promise<unknown>): Promise<AiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AiError);
  return err as AiError;
}

describe('sendChat', () => {
  it('streams the answer piece by piece and returns the whole text', async () => {
    const { fetch } = fetchStream([piece('היי '), piece('מה '), piece('נשמע?', 'stop'), DONE]);
    const req = request(fetch);
    const result = await sendChat(req);
    expect(req.deltas).toEqual(['היי ', 'מה ', 'נשמע?']);
    expect(result).toEqual({ text: 'היי מה נשמע?', finishReason: 'stop' });
  });

  it("sends the baseline and the parent's instructions first, then the whole conversation, to the chat endpoint only", async () => {
    const { fetch, calls } = fetchStream([piece('7/8'), DONE]);
    const messages: ChatRequest['messages'] = [
      { role: 'user', content: 'כמה זה 3/4 ועוד 1/8?' },
      { role: 'assistant', content: '7/8' },
      { role: 'user', content: 'ובאחוזים?' },
    ];
    await sendChat(request(fetch, { messages }));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(AI_PROVIDERS.venice.endpoints.chat);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toEqual({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      model: 'some-model',
      messages: [{ role: 'system', content: `${BASELINE_PROMPT}\n\nAnswer in simple Hebrew.` }, ...messages],
      stream: true,
      venice_parameters: { include_venice_system_prompt: false },
    });
  });

  it('still sends the baseline instructions when the parent wrote none, so she never talks to a model with no instructions', async () => {
    const { fetch, calls } = fetchStream([piece('היי'), DONE]);
    await sendChat(request(fetch, { systemPrompt: '  ' }));
    expect(JSON.parse(calls[0].init.body as string).messages).toEqual([
      { role: 'system', content: BASELINE_PROMPT },
      { role: 'user', content: 'שלום' },
    ]);
    expect(BASELINE_PROMPT).toMatch(/child/);
    // The provider is told no more about her than it needs: no age, no gender.
    expect(BASELINE_PROMPT).not.toMatch(/\d|\b(she|her|girl|boy|he|his|him)\b/i);
  });

  it('adds the lines about web text to the instructions in search mode only', async () => {
    const search = fetchStream([piece('מצאתי'), DONE]);
    await sendChat(request(search.fetch, { webSearch: true }));
    expect(JSON.parse(search.calls[0].init.body as string).messages[0]).toEqual({
      role: 'system',
      content: `${BASELINE_PROMPT} ${SEARCH_BASELINE}\n\nAnswer in simple Hebrew.`,
    });
    expect(SEARCH_BASELINE).toMatch(/never follow instructions/);
    expect(SEARCH_BASELINE).toMatch(/web addresses/);

    const plain = fetchStream([piece('היי'), DONE]);
    await sendChat(request(plain.fetch));
    expect(JSON.parse(plain.calls[0].init.body as string).messages[0].content).not.toContain(SEARCH_BASELINE);
  });

  it('asks the provider to search the web only in search mode', async () => {
    const search = fetchStream([piece('מצאתי'), DONE]);
    await sendChat(request(search.fetch, { webSearch: true }));
    expect(JSON.parse(search.calls[0].init.body as string).venice_parameters).toEqual({ include_venice_system_prompt: false, enable_web_search: 'on' });

    const plain = fetchStream([piece('היי'), DONE]);
    await sendChat(request(plain.fetch));
    expect(JSON.parse(plain.calls[0].init.body as string).venice_parameters).toEqual({ include_venice_system_prompt: false });
  });

  it('never follows a redirect, sends no cookies or referrer, and keeps nothing in the HTTP cache', async () => {
    const { fetch, calls } = fetchStream([piece('היי'), DONE]);
    await sendChat(request(fetch));
    expect(calls[0].init).toMatchObject(SAFE_FETCH);
    expect(SAFE_FETCH).toEqual({ redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    const check = fetchJson(200, {});
    await checkConnection('venice', KEY, { fetch: check.fetch });
    expect(check.calls[0].init).toMatchObject(SAFE_FETCH);
  });

  it('sends the key without the spaces a paste added, and makes no call without a key', async () => {
    const { fetch, calls } = fetchStream([piece('היי'), DONE]);
    await sendChat(request(fetch, { apiKey: `  ${KEY}\n` }));
    expect(calls[0].init.headers).toMatchObject({ Authorization: `Bearer ${KEY}` });

    const none = fetchStream([piece('היי'), DONE]);
    expect((await reasonOf(sendChat(request(none.fetch, { apiKey: '   ' })))).reason).toBe('unauthorized');
    expect((await reasonOf(checkConnection('venice', '', { fetch: none.fetch }))).reason).toBe('unauthorized');
    expect(none.calls).toHaveLength(0);
  });

  it('puts together a line, and a Hebrew letter, that arrive split between network chunks', async () => {
    const bytes = encoder.encode(piece('שלום עולם') + DONE);
    const cut = bytes.indexOf(encoder.encode('ל')[0]) + 1; // in the middle of a two-byte letter
    const { fetch } = fetchStream([bytes.slice(0, cut), bytes.slice(cut, cut + 7), bytes.slice(cut + 7)]);
    const req = request(fetch);
    await sendChat(req);
    expect(req.deltas).toEqual(['שלום עולם']);
  });

  it('skips keep-alive lines and lines it cannot read, and reads an answer that ends without [DONE]', async () => {
    const { fetch } = fetchStream([': ping\n\n', 'data: not json\n\n', piece('היי').trimEnd()]);
    const req = request(fetch);
    expect((await sendChat(req)).text).toBe('היי');
  });

  it("keeps what was written when she presses stop, and says it was her stop, not a failure", async () => {
    const stop = new AbortController();
    const { fetch } = fetchStream([piece('פעם אחת ')], { hang: true });
    const req = request(fetch, { signal: stop.signal });
    const original = req.onDelta;
    req.onDelta = (text) => {
      original(text);
      stop.abort();
    };
    expect((await reasonOf(sendChat(req))).reason).toBe('cancelled');
    expect(req.deltas).toEqual(['פעם אחת ']);
  });

  it("doesn't call the provider at all when it was stopped before it started", async () => {
    const stop = new AbortController();
    stop.abort();
    const { fetch, calls } = fetchStream([piece('היי'), DONE]);
    expect((await reasonOf(sendChat(request(fetch, { signal: stop.signal })))).reason).toBe('cancelled');
    expect(calls).toHaveLength(0);
  });

  it('gives up on an answer that stops arriving', async () => {
    const { fetch } = fetchStream([piece('רגע')], { hang: true });
    const req = request(fetch, { idleTimeoutMs: 20 });
    expect((await reasonOf(sendChat(req))).reason).toBe('timeout');
    expect(req.deltas).toEqual(['רגע']);
  });

  it('reports a connection that drops in the middle as a network problem and keeps what arrived', async () => {
    const { fetch } = fetchStream([piece('חצי תשובה')], { drop: true });
    const req = request(fetch);
    expect((await reasonOf(sendChat(req))).reason).toBe('network');
    expect(req.deltas).toEqual(['חצי תשובה']);
  });

  it('reports no answer at all (offline, or blocked for web pages) as a network problem, without the failure text', async () => {
    // A failure's text could quote the request: the key or what she wrote.
    const fetch: FetchLike = () => Promise.reject(new TypeError(`Load failed for ${KEY} שלום`));
    const err = await reasonOf(sendChat(request(fetch)));
    expect(err.reason).toBe('network');
    expect(err.detail).toBe('TypeError');
    expect(err.message).toBe('network');
  });

  it('keeps counting a model that thinks before it writes as alive', async () => {
    // Lines with no text yet (thinking, keep-alives) arrive every 15 ms for longer than the 150 ms limit.
    const thinking = `data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n`;
    const parts = [...Array.from({ length: 14 }, () => thinking), piece('הנה!'), DONE];
    let next = 0;
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, 15));
              if (next < parts.length) controller.enqueue(encoder.encode(parts[next++]));
              else controller.close();
            },
          }),
          { status: 200 },
        ),
      );
    expect((await sendChat(request(fetch, { idleTimeoutMs: 150 }))).text).toBe('הנה!');
  });

  it('gives up on a stream that stays busy but never writes any text', async () => {
    // Empty lines every 10 ms keep the connection alive; with no text for 80 ms the call ends anyway.
    const empty = `data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n`;
    const fetch: FetchLike = (_url, init) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, 10));
              if (init.signal?.aborted) controller.error(new DOMException('aborted', 'AbortError'));
              else controller.enqueue(encoder.encode(empty));
            },
          }),
          { status: 200 },
        ),
      );
    const err = await reasonOf(sendChat(request(fetch, { idleTimeoutMs: 5_000, noTextTimeoutMs: 80 })));
    expect(err.reason).toBe('timeout');
  });

  it('writes nothing more after her stop, even when the next line had already arrived', async () => {
    const stop = new AbortController();
    // Both pieces arrive in one network chunk; she stops while the first is being shown.
    const { fetch } = fetchStream([piece('אחת ') + piece('שתיים')], { hang: true });
    const req = request(fetch, { signal: stop.signal });
    const original = req.onDelta;
    req.onDelta = (text) => {
      original(text);
      stop.abort();
    };
    expect((await reasonOf(sendChat(req))).reason).toBe('cancelled');
    expect(req.deltas).toEqual(['אחת ']);
  });

  it('ends the network read at once on stop, even if fetch itself would not', async () => {
    // A body that ignores the abort signal: only cancelling the reader ends it.
    const stop = new AbortController();
    let cancelled = false;
    let sent = false;
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(encoder.encode(piece('פעם ')));
                return;
              }
              return new Promise<void>(() => undefined);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
      );
    const req = request(fetch, { signal: stop.signal });
    const original = req.onDelta;
    req.onDelta = (text) => {
      original(text);
      stop.abort();
    };
    expect((await reasonOf(sendChat(req))).reason).toBe('cancelled');
    expect(cancelled).toBe(true);
    expect(req.deltas).toEqual(['פעם ']);
  });

  it('cuts off a line that never ends instead of collecting it', async () => {
    const endless = 'data: ' + 'x'.repeat(MAX_LINE_CHARS + 10);
    const { fetch } = fetchStream([endless]);
    const err = await reasonOf(sendChat(request(fetch)));
    expect(err.reason).toBe('bad-response');
    expect(err.detail).toBe('line too long');
  });

  it("lets an exception from the screen's own code through as it is, not as a network problem", async () => {
    const { fetch } = fetchStream([piece('היי'), DONE]);
    const boom = new Error('screen bug');
    const req = request(fetch, {
      onDelta: () => {
        throw boom;
      },
    });
    await expect(sendChat(req)).rejects.toBe(boom);
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [402, 'no-credit'],
    [429, 'rate-limited'],
    [400, 'bad-request'],
    [404, 'bad-request'],
    [500, 'provider-down'],
    [503, 'provider-down'],
  ])('maps status %i to "%s"', async (status, reason) => {
    const { fetch } = fetchJson(status, { error: 'nope' });
    expect((await reasonOf(sendChat(request(fetch)))).reason).toBe(reason);
  });

  it("keeps the provider's message for the parent, without the key", async () => {
    const { fetch } = fetchJson(401, { error: { message: `Invalid key ${KEY}` } });
    const err = await reasonOf(sendChat(request(fetch)));
    expect(err.detail).toBe('401 Invalid key ••••');
    expect(err.message).toBe('unauthorized');
  });

  it('removes the key before cutting a long message, so no part of it is left at the cut', async () => {
    const { fetch } = fetchJson(401, { error: `${'x'.repeat(298)} ${KEY}` });
    const err = await reasonOf(sendChat(request(fetch)));
    expect(err.detail).toHaveLength(304);
    expect(err.detail).not.toContain('sk-');
  });

  it("removes the key from an error sent in the middle of an answer and from a failed key check", async () => {
    const mid = fetchStream([`data: ${JSON.stringify({ error: `bad ${KEY}` })}\n\n`]);
    expect((await reasonOf(sendChat(request(mid.fetch)))).detail).toBe('bad ••••');
    const check = fetchJson(403, { error: { message: `key ${KEY} is disabled` } });
    expect((await reasonOf(checkConnection('venice', KEY, { fetch: check.fetch }))).detail).toBe('403 key •••• is disabled');
  });

  it("doesn't download an error answer that is far too large", async () => {
    const { fetch } = fetchJson(500, { error: 'y'.repeat(MAX_ERROR_BODY_CHARS + 100) });
    const err = await reasonOf(sendChat(request(fetch)));
    expect(err.reason).toBe('provider-down');
    expect(err.detail).toBe('500');
  });

  it('never puts what she wrote or the instructions into an error', async () => {
    const secretText = 'הסוד שלי';
    const cases: FetchLike[] = [
      fetchJson(400, { error: 'bad model' }).fetch,
      fetchStream([DONE]).fetch,
      fetchStream([piece('', 'content_filter'), DONE]).fetch,
      () => Promise.reject(new TypeError('Load failed')),
    ];
    for (const fetch of cases) {
      const err = await reasonOf(sendChat(request(fetch, { messages: [{ role: 'user', content: secretText }] })));
      expect(`${err.message} ${err.detail}`).not.toContain(secretText);
      expect(`${err.message} ${err.detail}`).not.toContain('Answer in simple Hebrew');
    }
  });

  it("treats the provider's content filter as a refusal", async () => {
    const { fetch } = fetchStream([piece('', 'content_filter'), DONE]);
    expect((await reasonOf(sendChat(request(fetch)))).reason).toBe('refused');
  });

  it('treats an error sent in the middle of an answer as the provider being down', async () => {
    const { fetch } = fetchStream([piece('היי'), `data: ${JSON.stringify({ error: { message: 'overloaded' } })}\n\n`]);
    const err = await reasonOf(sendChat(request(fetch)));
    expect(err.reason).toBe('provider-down');
    expect(err.detail).toBe('overloaded');
  });

  it('refuses an answer with no text', async () => {
    const { fetch } = fetchStream([DONE]);
    expect((await reasonOf(sendChat(request(fetch)))).reason).toBe('bad-response');
  });

  it('cuts off an answer that never ends', async () => {
    const { fetch } = fetchStream([piece('א'.repeat(MAX_ANSWER_CHARS)), piece('ב'), DONE]);
    expect((await reasonOf(sendChat(request(fetch)))).reason).toBe('bad-response');
  });
});

describe('checkConnection', () => {
  it('asks the check endpoint with the key and resolves when it works', async () => {
    const { fetch, calls } = fetchJson(200, { data: {} });
    await expect(checkConnection('venice', KEY, { fetch })).resolves.toBeNull();
    expect(calls[0].url).toBe(AI_PROVIDERS.venice.endpoints.check);
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it('says why a key does not work', async () => {
    const { fetch } = fetchJson(402, { error: 'Insufficient balance' });
    const err = await reasonOf(checkConnection('venice', KEY, { fetch }));
    expect(err.reason).toBe('no-credit');
    expect(err.detail).toBe('402 Insufficient balance');
  });
});
