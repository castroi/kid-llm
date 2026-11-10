import { AI_PROVIDERS, type AiProviderId } from './catalog';
import { sseData } from './sse';

/**
 * One adapter per provider: how to ask for a chat answer and how to check a key.
 * Everything else (the timeout, telling a stop from a timeout, checking the answer) is
 * shared in src/ai/send.ts, so a new provider only describes its own request and response.
 * Adapted from kid-closet's src/ai/providers.ts.
 * Docs: Venice https://docs.venice.ai/api-reference/endpoint/chat/completions
 */

/** Why a call failed. The kid sees one friendly line; the parent area shows the reason. */
export type AiErrorReason =
  | 'unauthorized' // 401/403: wrong, disabled or restricted key
  | 'no-credit' // 402
  | 'rate-limited' // 429
  | 'bad-request' // 400/404/413/415: model name or request the provider doesn't accept
  | 'provider-down' // 5xx, or an error sent in the middle of an answer
  | 'refused' // the provider's content filter
  | 'network' // no answer, or the connection dropped: offline, or blocked for web pages (CORS)
  | 'timeout'
  | 'cancelled' // she pressed "עצירה"
  | 'bad-response'; // an answer with no text, or far too long

export class AiError extends Error {
  constructor(
    readonly reason: AiErrorReason,
    /** The provider's own message, for the parent; never shown to the kid. */
    readonly detail = '',
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
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
  /** The parent's instructions; sent first, before the conversation. Empty = none. */
  systemPrompt: string;
  /** The whole conversation so far, oldest first, ending with her new message. */
  messages: ChatMessage[];
  apiKey: string;
  signal: AbortSignal;
  fetch: FetchLike;
  /** Called with each piece of the answer as it arrives. */
  onDelta: (text: string) => void;
}

export interface ChatResult {
  /** The whole answer: every piece given to onDelta, joined. */
  text: string;
  /** Why the provider stopped ("stop", "length", "content_filter"), when it said. */
  finishReason: string | null;
}

export interface ProviderAdapter {
  streamChat(call: ChatCall): Promise<ChatResult>;
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

/** Turns a failed response into an AiError, with the provider's message (without the key) when it sent one. */
async function failure(response: Response, apiKey: string): Promise<AiError> {
  let detail = '';
  try {
    detail = errorMessage(((await response.json()) as { error?: unknown })?.error);
  } catch {
    // not JSON; the status says enough
  }
  return new AiError(reasonForStatus(response.status), `${response.status}${detail ? ` ${redact(detail, apiKey).slice(0, 300)}` : ''}`);
}

/** Calls fetch and maps "no answer at all" to `network` (offline, blocked by CORS, or the connection dropped). */
async function call(fetchFn: FetchLike, url: string, init: RequestInit, apiKey: string): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw err; // send.ts tells a timeout from a stop
    throw new AiError('network', redact(err instanceof Error ? err.message : String(err), apiKey));
  }
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
async function readChatStream(response: Response, apiKey: string, signal: AbortSignal, onDelta: (text: string) => void): Promise<ChatResult> {
  if (!response.body) throw new AiError('bad-response', 'no answer body');
  let text = '';
  let finishReason: string | null = null;
  try {
    for await (const data of sseData(response.body)) {
      if (signal.aborted) throw new DOMException('The answer was stopped', 'AbortError');
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
        onDelta(delta);
      }
    }
  } catch (err) {
    if (err instanceof AiError || signal.aborted) throw err; // send.ts tells a timeout from a stop
    throw new AiError('network', redact(err instanceof Error ? err.message : String(err), apiKey));
  }
  return { text, finishReason };
}

const venice: ProviderAdapter = {
  async streamChat({ model, systemPrompt, messages, apiKey, signal, fetch, onDelta }) {
    const init: RequestInit = {
      method: 'POST',
      headers: headers(apiKey, true),
      body: JSON.stringify({
        model,
        messages: [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), ...messages],
        stream: true,
        // Venice adds its own system prompt unless told not to; only the parent's goes with her chat.
        venice_parameters: { include_venice_system_prompt: false },
      }),
      signal,
    };
    const response = await call(fetch, AI_PROVIDERS.venice.endpoints.chat, init, apiKey);
    if (!response.ok) throw await failure(response, apiKey);
    return readChatStream(response, apiKey, signal, onDelta);
  },
  async checkKey({ apiKey, signal, fetch }) {
    const response = await call(fetch, AI_PROVIDERS.venice.endpoints.check, { method: 'GET', headers: headers(apiKey, false), signal }, apiKey);
    if (!response.ok) throw await failure(response, apiKey);
    return null;
  },
};

export const ADAPTERS: Record<AiProviderId, ProviderAdapter> = { venice };
