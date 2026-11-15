import { AI_PROVIDERS, type AiProviderId } from './catalog';
import { attestationNonce, decryptPiece, encryptFor, looksEncrypted, modelKeyFrom, newClientKeys, quoteBytes, quoteIsNotDebug, quoteNamesKey, wipe } from './e2ee';
import { dataUrl, SENT_FILE_NAMES, type ChatFile } from './files';
import { sanitizeModels, type ModelInfo, type ModelKind } from './models';
import { sanitizeSources, type Source } from './sources';
import { LineTooLongError, sseData } from './sse';
import { checkQuote } from './tdxQuote';

/**
 * One adapter per provider: how to ask for a chat answer and how to check a key.
 * Everything else (the timeout, telling a stop from a timeout, checking the answer) is
 * shared in src/ai/send.ts, so a new provider only describes its own request and response.
 * Adapted from kid-closet's src/ai/providers.ts.
 * Docs: Venice https://docs.venice.ai/api-reference/endpoint/chat/completions
 *       and https://docs.venice.ai/api-reference/endpoint/image/generate
 *       Files in a chat: https://docs.venice.ai/guides/features/vision and .../guides/features/file-inputs
 *       The list of models: https://docs.venice.ai/api-reference/endpoint/models/list
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
  | 'not-verified' // end-to-end encryption: the enclave's attestation didn't pass, so nothing of hers was sent
  | 'bad-response'; // an answer with no text, far too long, or that could not be decrypted

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
  /** A picture or a document she attached to this message (src/ai/files.ts). Only on a message of hers. */
  file?: ChatFile;
}

export interface ChatCall {
  model: string;
  /** The baseline and the parent's instructions (src/ai/baseline.ts); sent first. Empty only in a parent's own use with nothing written: then no system message is sent. */
  systemPrompt: string;
  /** The whole conversation so far, oldest first, ending with her new message. */
  messages: ChatMessage[];
  apiKey: string;
  signal: AbortSignal;
  fetch: FetchLike;
  /** Search mode: the provider looks the question up on the web before it answers. */
  webSearch: boolean;
  /**
   * End-to-end encryption (src/ai/e2ee.ts): the enclave's attestation is checked first, the
   * system and user messages leave the phone encrypted, and the answer is decrypted here.
   * Never together with `webSearch` or a file (send.ts decides).
   */
  e2ee: boolean;
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
  /** Search mode only: the websites the answer was drawn from, when the provider named any (src/ai/sources.ts). */
  sources?: Source[];
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
  /** The provider's models for the parent area's picker: text models first, then image models. Carries the key only. */
  listModels(call: { apiKey: string; signal: AbortSignal; fetch: FetchLike }): Promise<ModelInfo[]>;
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

/** A list of a few hundred models with their descriptions is well under this; more isn't downloaded. */
export const MAX_MODELS_BODY_CHARS = 4 * 1024 * 1024;

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
  /** Venice: the pages a web search found, in `web_search_citations` (its docs: "in the first chunk of a streaming result"). */
  venice_parameters?: { web_search_citations?: unknown } | null;
}

/**
 * Reads a streamed chat answer in the OpenAI-compatible format: one JSON chunk per
 * "data:" line with the next piece of text, then "data: [DONE]".
 */
async function readChatStream(response: Response, { apiKey, signal, webSearch, onDelta, onAlive }: ChatCall, decrypt?: (content: string) => string): Promise<ChatResult> {
  if (!response.body) throw new AiError('bad-response', 'no answer body');
  let text = '';
  let finishReason: string | null = null;
  let sources: Source[] = [];
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
      // Read in search mode only, wherever in the stream they arrive; the first list that
      // holds a usable address is kept. Only the addresses are taken (src/ai/sources.ts).
      if (webSearch && sources.length === 0) sources = sanitizeSources(chunk?.venice_parameters?.web_search_citations);
      const choice = chunk?.choices?.[0];
      if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
      const content = choice?.delta?.content;
      const delta = typeof content === 'string' && content && decrypt ? decrypt(content) : content;
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
  return sources.length > 0 ? { text, finishReason, sources } : { text, finishReason };
}

/**
 * One turn as Venice takes it. A message with a file is sent in parts: her text first, then
 * the file inside the request itself as a `data:` address. A picture goes to a vision model
 * as it is; Venice turns a document into text before the model sees it.
 */
function veniceMessage({ role, content, file }: ChatMessage): unknown {
  if (!file || role !== 'user') return { role, content };
  const part =
    file.kind === 'image'
      ? { type: 'image_url', image_url: { url: dataUrl(file) } }
      : { type: 'file', file: { file_data: dataUrl(file), filename: SENT_FILE_NAMES[file.kind] } };
  return { role, content: [{ type: 'text', text: content }, part] };
}

/** An attestation is one JSON answer with a TDX quote and maybe GPU evidence; more than this isn't downloaded. */
export const MAX_ATTESTATION_BODY_CHARS = 1024 * 1024;

/**
 * Asks Venice for the enclave's attestation for `model`, with a fresh 32-byte nonce, and
 * makes the checks the docs list: Venice's own verification passed, the nonce came back,
 * it is the model asked for, the TDX quote is not in debug mode, and the model's key is a
 * valid point. Then two checks that don't rest on Venice's word: Intel hardware signed the
 * quote (tdxQuote.ts), and the quote itself holds this model key and this call's nonce
 * (e2ee.ts, `quoteNamesKey`). So a key the provider made up, or an old quote, fails.
 * Anything missing or unreadable fails: then nothing of hers is sent.
 * What this does NOT prove: which software runs in the enclave (the quote's measurements
 * are not compared with anything), that the processor's firmware is up to date or its
 * certificate not revoked, and the NVIDIA GPU evidence. A provider that runs other software
 * on a real Intel TDX machine passes. Returns the model's key, checked and as given.
 * Docs: https://docs.venice.ai/guides/features/tee-e2ee-models#step-3-fetch-and-verify-tee-attestation
 */
async function attest(model: string, apiKey: string, signal: AbortSignal, fetchFn: FetchLike): Promise<{ key: string; asGiven: string }> {
  const nonce = attestationNonce();
  const url = `${AI_PROVIDERS.venice.endpoints.attestation}?model=${encodeURIComponent(model)}&nonce=${nonce}`;
  const response = await call(fetchFn, url, { method: 'GET', headers: headers(apiKey, false), signal });
  if (!response.ok) throw await failure(response, apiKey);
  let text: string;
  try {
    text = await readLimitedText(response, MAX_ATTESTATION_BODY_CHARS);
  } catch (err) {
    if (signal.aborted) throw err; // send.ts tells a timeout from a stop
    throw new AiError('network', errorName(err));
  }
  if (text.length > MAX_ATTESTATION_BODY_CHARS) throw new AiError('not-verified', 'attestation too long');
  let report: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    report = parsed as Record<string, unknown>;
  } catch {
    throw new AiError('not-verified', 'attestation unreadable');
  }
  if (report.verified !== true) throw new AiError('not-verified', 'attestation not verified by the provider');
  if (typeof report.nonce !== 'string' || report.nonce.toLowerCase() !== nonce) throw new AiError('not-verified', 'attestation nonce mismatch');
  // In any letter case: a name typed by hand may differ from the provider's in case only.
  if (typeof report.model !== 'string' || report.model.toLowerCase() !== model.toLowerCase()) throw new AiError('not-verified', 'attestation is for another model');
  const quote = typeof report.intel_quote === 'string' ? quoteBytes(report.intel_quote) : null;
  if (!quote || !quoteIsNotDebug(report.intel_quote)) throw new AiError('not-verified', 'enclave in debug mode, or no readable TDX quote');
  const given = report.signing_key ?? report.signing_public_key;
  const key = modelKeyFrom(given);
  if (!key || typeof given !== 'string') throw new AiError('not-verified', 'no usable model key in the attestation');
  // The phone's clock decides whether Intel's certificates are in date.
  const signed = checkQuote(quote, Date.now());
  if (!signed.ok) throw new AiError('not-verified', `TDX quote: ${signed.why}`);
  if (!quoteNamesKey(signed.reportData, key, nonce)) throw new AiError('not-verified', 'the TDX quote does not hold this model key and this nonce');
  // The header carries the key as the attestation gave it, as in the docs' example; it is hex, so it is safe in a header.
  return { key, asGiven: given };
}

/** The three headers that switch E2EE on, and nothing in a system or user message that isn't encrypted. */
export function encryptedRequestProblem(headers: Record<string, string>, messages: readonly { role: string; content: unknown }[]): string | null {
  if (!/^04[0-9a-f]{128}$/.test(headers['X-Venice-TEE-Client-Pub-Key'] ?? '')) return 'no valid client key header';
  if (modelKeyFrom(headers['X-Venice-TEE-Model-Pub-Key']) === null) return 'no valid model key header';
  if (headers['X-Venice-TEE-Signing-Algo'] !== 'ecdsa') return 'no signing algorithm header';
  for (const { role, content } of messages) {
    if (role === 'assistant') continue;
    if (typeof content !== 'string' || !looksEncrypted(content)) return `a ${role} message that is not encrypted`;
  }
  return null;
}

/**
 * The same chat call, end-to-end encrypted: a key pair for this call only, the enclave's
 * attestation checked, every system and user message encrypted to the model's key, the
 * three X-Venice-TEE headers, and every piece of the answer decrypted. A piece that is
 * not encrypted, or that doesn't decrypt, ends the call: with E2EE on, a plain piece was
 * not written by the holder of the attested key.
 * Docs: https://docs.venice.ai/guides/features/tee-e2ee-models#e2ee-models
 */
async function streamChatE2ee(chat: ChatCall): Promise<ChatResult> {
  const { model, systemPrompt, messages, apiKey, signal, fetch } = chat;
  if (chat.webSearch || messages.some((message) => message.file !== undefined)) {
    // send.ts never asks for this; a file or a search would need the plain text outside the enclave.
    throw new AiError('bad-request', 'web search and files are not sent end-to-end encrypted');
  }
  const keys = newClientKeys();
  try {
    const modelKey = await attest(model, apiKey, signal, fetch);
    // Stopped (or timed out) while the attestation was checked: her messages are not sent.
    if (signal.aborted) throw new DOMException('The answer was stopped', 'AbortError');
    // The docs: only system and user messages are encrypted; earlier answers go as they are.
    const sent = [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), ...messages.map(({ role, content }) => ({ role, content }))].map((message) =>
      message.role === 'assistant' ? message : { role: message.role, content: encryptFor(modelKey.key, message.content) },
    );
    const sentHeaders: Record<string, string> = {
      ...headers(apiKey, true),
      'X-Venice-TEE-Client-Pub-Key': keys.publicKeyHex,
      'X-Venice-TEE-Model-Pub-Key': modelKey.asGiven,
      'X-Venice-TEE-Signing-Algo': 'ecdsa',
    };
    // Checked once more just before it leaves: without these headers Venice would not treat the call as E2EE.
    const problem = encryptedRequestProblem(sentHeaders, sent);
    if (problem) throw new AiError('bad-request', problem);
    const init: RequestInit = {
      method: 'POST',
      headers: sentHeaders,
      body: JSON.stringify({
        model,
        messages: sent,
        stream: true,
        venice_parameters: { include_venice_system_prompt: false },
      }),
      signal,
    };
    const response = await call(fetch, AI_PROVIDERS.venice.endpoints.chat, init);
    if (!response.ok) throw await failure(response, apiKey);
    return await readChatStream(response, chat, (content) => {
      if (!looksEncrypted(content)) throw new AiError('bad-response', 'an unencrypted piece in an encrypted answer');
      try {
        return decryptPiece(keys.secretKey, content);
      } catch {
        // The docs: don't show decryption errors; the reason is enough.
        throw new AiError('bad-response', 'a piece of the answer could not be decrypted');
      }
    });
  } finally {
    wipe(keys);
  }
}

const venice: ProviderAdapter = {
  async streamChat(chat) {
    if (chat.e2ee) return streamChatE2ee(chat);
    const { model, systemPrompt, messages, apiKey, signal, fetch, webSearch } = chat;
    const init: RequestInit = {
      method: 'POST',
      headers: headers(apiKey, true),
      body: JSON.stringify({
        model,
        messages: [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), ...messages.map(veniceMessage)],
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
  async listModels(request) {
    const [text, image] = await Promise.all([veniceModels('text', request), veniceModels('image', request)]);
    return [...text, ...image];
  },
};

/** One kind of Venice's models ("text" or "image"), read with a size limit and cleaned (src/ai/models.ts). */
async function veniceModels(kind: ModelKind, { apiKey, signal, fetch }: { apiKey: string; signal: AbortSignal; fetch: FetchLike }): Promise<ModelInfo[]> {
  const response = await call(fetch, `${AI_PROVIDERS.venice.endpoints.models}?type=${kind}`, { method: 'GET', headers: headers(apiKey, false), signal });
  if (!response.ok) throw await failure(response, apiKey);
  let text: string;
  try {
    text = await readLimitedText(response, MAX_MODELS_BODY_CHARS);
  } catch (err) {
    if (signal.aborted) throw err; // send.ts tells a timeout from a stop
    throw new AiError('network', errorName(err));
  }
  if (text.length > MAX_MODELS_BODY_CHARS) throw new AiError('bad-response', 'models list too long');
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    throw new AiError('bad-response', 'models list unreadable');
  }
  return sanitizeModels(list, kind);
}

export const ADAPTERS: Record<AiProviderId, ProviderAdapter> = { venice };
