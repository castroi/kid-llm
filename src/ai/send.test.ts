// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS } from './catalog';
import { AiError, MAX_ANSWER_CHARS, type FetchLike } from './providers';
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

  it("sends the parent's instructions first, then the whole conversation, to the chat endpoint only", async () => {
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
      messages: [{ role: 'system', content: 'Answer in simple Hebrew.' }, ...messages],
      stream: true,
      venice_parameters: { include_venice_system_prompt: false },
    });
  });

  it('sends no system message when the parent wrote no instructions', async () => {
    const { fetch, calls } = fetchStream([piece('היי'), DONE]);
    await sendChat(request(fetch, { systemPrompt: '' }));
    expect(JSON.parse(calls[0].init.body as string).messages).toEqual([{ role: 'user', content: 'שלום' }]);
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

  it('reports no answer at all (offline, or blocked for web pages) as a network problem', async () => {
    const fetch: FetchLike = () => Promise.reject(new TypeError('Load failed'));
    expect((await reasonOf(sendChat(request(fetch)))).reason).toBe('network');
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
    expect(err.message).not.toContain(KEY);
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
