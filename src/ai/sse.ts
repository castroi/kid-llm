/** Far longer than any real line of a streamed answer (each carries a few words). */
export const MAX_LINE_CHARS = 256 * 1024;

/** A line with no end: a broken or hostile stream. It is cut before it fills the phone's memory. */
export class LineTooLongError extends Error {
  constructor() {
    super('line too long');
    this.name = 'LineTooLongError';
  }
}

/**
 * Reads a streamed answer (server-sent events) and yields the text after each "data:".
 * Chunks from the network can end in the middle of a line or of a Hebrew letter, so
 * bytes are decoded as a stream and only whole lines are yielded.
 * When `signal` aborts, the body is cancelled right away and the generator ends; the
 * caller checks the signal to tell that from a normal end.
 */
export async function* sseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // Doesn't rely on fetch breaking the body when its signal aborts.
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', onAbort);
  let buffer = '';
  const dataOf = (line: string) => (line.startsWith('data:') ? line.slice(5).trim() : null);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Only the new part can hold a newline: the rest was searched when it arrived.
      const searchFrom = buffer.length;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n', searchFrom);
      while (newline >= 0) {
        const data = dataOf(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (data !== null) yield data;
        newline = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_LINE_CHARS) throw new LineTooLongError();
    }
    // A last line the provider didn't end with a newline.
    const data = dataOf(buffer + decoder.decode());
    if (data !== null) yield data;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Also when the caller stops early: tell the network we're done.
    await reader.cancel().catch(() => undefined);
  }
}
