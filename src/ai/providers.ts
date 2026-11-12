import { AI_PROVIDERS, type AiProviderId } from './catalog';
import { LineTooLongError, sseData } from './sse';

/**
 * One adapter per provider: how to ask for a chat answer and how to check a key.
 * Everything else (the timeout, telling a stop from a timeout, checking the answer) is
 * shared in src/ai/send.ts, so a new provider only describes its own request and response.
 * Adapted from kid-closet's src/ai/providers.ts.
 * Docs: Venice https://docs.venice.ai/api-reference/endpoint/chat/completions
 *       and https://docs.venice.ai/api-reference/endpoint/image/generate
 */

/** Why a call failed. The kid sees one friendly line; the parent area shows the reason. */
export type AiErrorReason =
  | 'unauthorized' // 401/403: wrong, disabled or restricted key
  | 'no-credit' // 402
  | 'rate-limited' // 429
  | 'bad-request' // 400/404/413/415: model name or request the provider doesn't accept
  | 'provider-down' // 5xx, or an error sent in the middle of an answer
  | 'refused' // the provider's content filter (also 422, and a picture it blurred or flagged)
  | 'network' // no answer, or the connection dropped: offline, or blocked for web pages (CORS)
  | 'timeout'
  | 'cancelled' // she pressed "עצירה"
  | 'bad-response'; // an answer with no text, or far too long

export class AiError extends Error {
  constructor(
    readonly reason: AiErrorReason,
    /**
     * The provider's own message, for the parent area only: never shown to the kid, and
     * never stored, backed up or logged (a provider may quote part of the request in it).
     */
    readonly detail = '',
  ) {
    // The reason only, so the detail can't travel with the error into a log or a crash report.
    super(reason);
    this.name = 'AiError';
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** One turn of the conversation, as it is sent to the provider. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatCall {
  model: string;
  /** The baseline and the parent's instructions (src/ai/baseline.ts); sent first, never empty. */
  systemPrompt: string;
  /** The whole conversation so far, oldest first, ending with her new message. */
  messages: ChatMessage[];
  apiKey: string;
  signal: AbortSignal;
  fetch: FetchLike;
  /** Search mode: the provider looks the question up on the web before it answers. */
  webSearch: boolean;
  /** Called with each piece of the answer as it arrives. */
  onDelta: (text: string) => void;
  /** Called whenever the provider sends anything, also while a model thinks before it writes. */
  onAlive: () => void;
}

export interface ChatResult {
  /** The whole answer: every piece given to onDelta, joined. */
  text: string;
  /** Why the provider stopped ("stop", "length", "content_filter"), when it said. */
  finishReason: string | null;
}

/** A picture as it came from the provider and as it is kept on the phone. */
export interface GeneratedImage {
  type: ImageType;
  bytes: ArrayBuffer;
}

export const IMAGE_TYPES = ['image/webp', 'image/png', 'image/jpeg'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** Well above a real picture (a 1024 px WebP is under 1 MB); more than this is not downloaded or kept. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface ImageCall {
  model: string;
  /** What she asked for, with the child-safety line added (src/ai/baseline.ts). */
  prompt: string;
  apiKey: string;
  signal: AbortSignal;
  fetch: FetchLike;
}

export interface ProviderAdapter {
  streamChat(call: ChatCall): Promise<ChatResult>;
  /** Makes one picture. A picture the provider blurred or flagged is a refusal, never shown. */
  generateImage(call: ImageCall): Promise<GeneratedImage>;
  /** Resolves when the key works; the text, if any, is shown to the parent. */
  checkKey(call: { apiKey: string; signal: AbortSignal; fetch: FetchLike }): Promise<string | null>;
}

/** Far above any real answer; stops a runaway stream from filling the phone's memory. */
export const MAX_ANSWER_CHARS = 200_000;

/** Some providers repeat the key in an auth error; it must never reach the screen or storage. */
function redact(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join('••••') : text;
}

function reasonForStatus(status: number): AiErrorReason {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 402) return 'no-credit';
  if (status === 429) return 'rate-limited';
  // 422: the provider's content policy refused the request.
  if (status === 422) return 'refused';
  if (status >= 500) return 'provider-down';
  return 'bad-request';
}

/** The message inside a provider's `error` field, whether it is text or `{ message }`. */
function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return '';
}

/** An error answer is a short JSON; more than this isn't downloaded. */
export const MAX_ERROR_BODY_CHARS = 16 * 1024;

/** Reads at most `max` characters of a response and drops the rest. */
async function readLimitedText(response: Response, max: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length <= max) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

/** Reads a response's bytes, and gives up with `bad-response` past `max`. */
async function readLimitedBytes(response: Response, max: number): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new AiError('bad-response', 'picture too large');
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.byteLength;
  }
  return whole.buffer;
}

/** Turns a failed response into an AiError, with the provider's message (without the key) when it sent one. */
async function failure(response: Response, apiKey: string): Promise<AiError> {
  let detail = '';
  try {
    const text = await readLimitedText(response, MAX_ERROR_BODY_CHARS);
    if (text.length <= MAX_ERROR_BODY_CHARS) detail = errorMessage((JSON.parse(text) as { error?: unknown })?.error);
  } catch {
    // not JSON, or cut off; the status says enough
  }
  return new AiError(reasonForStatus(response.status), `${response.status}${detail ? ` ${redact(detail, apiKey).slice(0, 300)}` : ''}`);
}

/** Calls fetch and maps "no answer at all" to `network` (offline, blocked by CORS, a redirect, or the connection dropped). */
async function call(fetchFn: FetchLike, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchFn(url, { ...init, ...SAFE_FETCH });
  } catch (err) {
    if (init.signal?.aborted) throw err; // send.ts tells a timeout from a stop
    throw new AiError('network', errorName(err));
  }
}

/**
 * For every call: never follow a redirect (it would resend the key and her whole conversation
 * to wherever it points), send no cookies, keep nothing in the HTTP cache, send no referrer.
 */
export const SAFE_FETCH = { redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' } as const;

/** The kind of failure only ("TypeError"), never its text: a message could quote the request. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

function headers(apiKey: string, json: boolean): Record<string, string> {
  return json ? { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } : { Authorization: `Bearer ${apiKey}` };
}

interface StreamChunk {
  error?: unknown;
  choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[];
}

/**
 * Reads a streamed chat answer in the OpenAI-compatible format: one JSON chunk per
 * "data:" line with the next piece of text, then "data: [DONE]".
 */
async function readChatStream(response: Response, { apiKey, signal, onDelta, onAlive }: ChatCall): Promise<ChatResult> {
  if (!response.body) throw new AiError('bad-response', 'no answer body');
  let text = '';
  let finishReason: string | null = null;
  // An exception from the screen's own code is not a network failure; it passes through as it is.
  const fromCaller: { thrown: boolean; error?: unknown } = { thrown: false };
  try {
    for await (const data of sseData(response.body, signal)) {
      // After her stop (or a timeout) nothing more is written, even if a whole line was already waiting.
      if (signal.aborted) break;
      onAlive();
      if (data === '[DONE]') break;
      let chunk: StreamChunk | null;
      try {
        chunk = JSON.parse(data) as StreamChunk | null;
      } catch {
        continue; // a keep-alive or a line we don't know; the text lines still count
      }
      if (chunk?.error) throw new AiError('provider-down', redact(errorMessage(chunk.error), apiKey).slice(0, 300));
      const choice = chunk?.choices?.[0];
      if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
      const delta = choice?.delta?.content;
      if (typeof delta === 'string' && delta) {
        text += delta;
        if (text.length > MAX_ANSWER_CHARS) throw new AiError('bad-response', 'answer too long');
        try {
          onDelta(delta);
        } catch (error) {
          fromCaller.thrown = true;
          fromCaller.error = error;
          throw error;
        }
      }
    }
    // A stop or a timeout ends the stream quietly (sse.ts); say so, for send.ts to name it.
    if (signal.aborted) throw new DOMException('The answer was stopped', 'AbortError');
  } catch (err) {
    if (err instanceof AiError || signal.aborted || (fromCaller.thrown && fromCaller.error === err)) throw err;
    if (err instanceof LineTooLongError) throw new AiError('bad-response', 'line too long');
    throw new AiError('network', errorName(err));
  }
  return { text, finishReason };
}

const venice: ProviderAdapter = {
  async streamChat(chat) {
    const { model, systemPrompt, messages, apiKey, signal, fetch, webSearch } = chat;
    const init: RequestInit = {
      method: 'POST',
      headers: headers(apiKey, true),
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        stream: true,
        // Venice adds its own system prompt unless told not to; only the parent's goes with her chat.
        // Search mode always searches ("on"), so she gets what she picked; other modes never do.
        venice_parameters: { include_venice_system_prompt: false, ...(webSearch ? { enable_web_search: 'on' } : {}) },
      }),
      signal,
    };
    const response = await call(fetch, AI_PROVIDERS.venice.endpoints.chat, init);
    if (!response.ok) throw await failure(response, apiKey);
    return readChatStream(response, chat);
  },
  async generateImage({ model, prompt, apiKey, signal, fetch }) {
    const init: RequestInit = {
      method: 'POST',
      headers: headers(apiKey, true),
      // safe_mode stays on (Venice's default) and is always sent: it's a kid's app.
      // The picture comes back as the answer's bytes, so the refusal headers below come with it.
      body: JSON.stringify({ model, prompt, safe_mode: true, return_binary: true, format: 'webp' }),
      signal,
    };
    const response = await call(fetch, AI_PROVIDERS.venice.endpoints.image, init);
    if (!response.ok) throw await failure(response, apiKey);
    // With safe mode on, an adult picture comes back blurred, and one against the provider's
    // terms comes back flagged; Venice says which in two headers. A picture is shown only
    // when both say "false". A header that is missing counts as a refusal too: a web page
    // can read these headers only if Venice exposes them (CORS), and a picture nobody could
    // check is not shown to her.
    const checkedFine = response.headers.get('x-venice-is-blurred') === 'false' && response.headers.get('x-venice-is-content-violation') === 'false';
    if (!checkedFine) {
      const unreadable = response.headers.get('x-venice-is-blurred') === null || response.headers.get('x-venice-is-content-violation') === null;
      await response.body?.cancel().catch(() => undefined);
      throw new AiError('refused', unreadable ? 'the picture safety headers could not be read' : '');
    }
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!(IMAGE_TYPES as readonly string[]).includes(type)) {
      await response.body?.cancel().catch(() => undefined);
      throw new AiError('bad-response', 'not a picture');
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await readLimitedBytes(response, MAX_IMAGE_BYTES);
    } catch (err) {
      if (err instanceof AiError || signal.aborted) throw err; // send.ts tells a timeout from a stop
      throw new AiError('network', errorName(err));
    }
    if (bytes.byteLength === 0) throw new AiError('bad-response', 'empty picture');
    return { type: type as ImageType, bytes };
  },
  async checkKey({ apiKey, signal, fetch }) {
    const response = await call(fetch, AI_PROVIDERS.venice.endpoints.check, { method: 'GET', headers: headers(apiKey, false), signal });
    if (!response.ok) throw await failure(response, apiKey);
    return null;
  },
};

export const ADAPTERS: Record<AiProviderId, ProviderAdapter> = { venice };
