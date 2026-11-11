import { imagePromptFor, systemPromptFor } from './baseline';
import type { AiProviderId } from './catalog';
import { ADAPTERS, AiError, type ChatMessage, type ChatResult, type FetchLike, type GeneratedImage } from './providers';

/**
 * The only way the app calls a provider. It applies the timeout, tells her "עצירה" from
 * a timeout, and checks that an answer came back. Adapted from kid-closet's src/ai/send.ts.
 *
 * The provider keeps nothing between calls: every call carries the whole conversation
 * (`messages`). The baseline instructions (src/ai/baseline.ts) go first, then the parent's.
 */

/** Nothing from the provider for this long means the call hangs. A long answer is fine: everything it sends restarts the clock. */
export const CHAT_IDLE_TIMEOUT_MS = 60_000;
/**
 * No text of the answer for this long ends the call too, however busy the connection looks:
 * a model may think for a while before it writes, but a stream of empty lines must not keep
 * the call open for ever.
 */
export const CHAT_NO_TEXT_TIMEOUT_MS = 180_000;
export const CHECK_TIMEOUT_MS = 20_000;
/** A picture arrives whole, with nothing in between; this is the longest she waits for one. */
export const IMAGE_TIMEOUT_MS = 120_000;

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/**
 * The key as it is sent: without the spaces or line breaks a paste can add (they would
 * also stop the key from being recognised and removed from an error message). No key: no call.
 */
function usableKey(apiKey: string): string {
  const key = apiKey.trim();
  if (!key) throw new AiError('unauthorized', 'no key');
  return key;
}

/**
 * Runs `work` with a signal that aborts on the caller's stop, after `timeoutMs` without a
 * call to `alive`, or after `noProgressMs` without a call to `progress`, and reports whether
 * it was a stop or a timeout.
 */
async function withDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  work: (signal: AbortSignal, alive: () => void, progress: () => void) => Promise<T>,
  noProgressMs?: number,
): Promise<T> {
  // Stopped before it started: don't call the provider at all.
  if (signal?.aborted) throw new AiError('cancelled');
  const controller = new AbortController();
  let timedOut = false;
  const expire = () => {
    timedOut = true;
    controller.abort();
  };
  let timer = setTimeout(expire, timeoutMs);
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(expire, timeoutMs);
  };
  let progressTimer = noProgressMs === undefined ? undefined : setTimeout(expire, noProgressMs);
  const progress = () => {
    if (noProgressMs === undefined) return;
    clearTimeout(progressTimer);
    progressTimer = setTimeout(expire, noProgressMs);
  };
  const onStop = () => controller.abort();
  signal?.addEventListener('abort', onStop);
  try {
    return await work(controller.signal, alive, progress);
  } catch (err) {
    // An abort makes fetch (or reading the answer) fail with a plain AbortError; say which abort it was.
    if (controller.signal.aborted && !(err instanceof AiError)) {
      throw new AiError(timedOut ? 'timeout' : 'cancelled');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    clearTimeout(progressTimer);
    signal?.removeEventListener('abort', onStop);
  }
}

export interface ChatRequest {
  provider: AiProviderId;
  /** The model the parent chose for the mode she is in. */
  model: string;
  /** What the parent wrote; may be empty. The baseline instructions are always sent before it. */
  systemPrompt: string;
  /** The whole conversation so far, oldest first, ending with her new message. */
  messages: ChatMessage[];
  apiKey: string;
  /** Search mode: look the question up on the web first. What is sent in `messages` then also reaches a search engine, through the provider. */
  webSearch?: boolean;
  /** Called with each piece of the answer as it arrives, so she sees it being written. */
  onDelta: (text: string) => void;
  /** Her "עצירה". The pieces already given to onDelta stay hers to keep. */
  signal?: AbortSignal;
  fetch?: FetchLike;
  idleTimeoutMs?: number;
  noTextTimeoutMs?: number;
}

/**
 * Sends the conversation to the provider the parent picked and streams the answer back.
 * Throws AiError with a reason the UI can explain; after a stop, a timeout or a dropped
 * connection the pieces already delivered are a partial answer the UI may keep.
 */
export async function sendChat(req: ChatRequest): Promise<ChatResult> {
  const apiKey = usableKey(req.apiKey);
  const work = (signal: AbortSignal, alive: () => void, progress: () => void) =>
    ADAPTERS[req.provider].streamChat({
      model: req.model,
      systemPrompt: systemPromptFor(req.systemPrompt, req.webSearch === true),
      messages: req.messages,
      apiKey,
      webSearch: req.webSearch === true,
      signal,
      fetch: req.fetch ?? defaultFetch,
      onDelta: (text) => {
        progress();
        req.onDelta(text);
      },
      onAlive: alive,
    });
  const result = await withDeadline(req.signal, req.idleTimeoutMs ?? CHAT_IDLE_TIMEOUT_MS, work, req.noTextTimeoutMs ?? CHAT_NO_TEXT_TIMEOUT_MS);
  if (result.finishReason === 'content_filter') throw new AiError('refused');
  if (result.text === '') throw new AiError('bad-response', 'no answer text');
  return result;
}

export interface ImageRequest {
  provider: AiProviderId;
  /** The model the parent chose for drawing. */
  model: string;
  /** What she asked to draw, as she wrote it. Nothing else of the chat is sent. */
  prompt: string;
  apiKey: string;
  /** Her "עצירה". */
  signal?: AbortSignal;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Asks the provider for one picture of what she wrote, with safe mode on and the
 * child-safety line added. Throws AiError with a reason the UI can explain; a picture the
 * provider blurred or flagged is `refused` and never reaches the screen.
 */
export function generateImage(req: ImageRequest): Promise<GeneratedImage> {
  return withDeadline(req.signal, req.timeoutMs ?? IMAGE_TIMEOUT_MS, async (signal) =>
    ADAPTERS[req.provider].generateImage({
      model: req.model,
      prompt: imagePromptFor(req.prompt),
      apiKey: usableKey(req.apiKey),
      signal,
      fetch: req.fetch ?? defaultFetch,
    }),
  );
}

/** Checks the parent's key against the provider ("בדיקת חיבור"). Resolves with a note to show, if any. */
export function checkConnection(
  provider: AiProviderId,
  apiKey: string,
  options: { signal?: AbortSignal; fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<string | null> {
  return withDeadline(options.signal, options.timeoutMs ?? CHECK_TIMEOUT_MS, async (signal) =>
    ADAPTERS[provider].checkKey({ apiKey: usableKey(apiKey), signal, fetch: options.fetch ?? defaultFetch }),
  );
}
