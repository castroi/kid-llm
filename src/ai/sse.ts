/**
 * Reads a streamed answer (server-sent events) and yields the text after each "data:".
 * Chunks from the network can end in the middle of a line or of a Hebrew letter, so
 * bytes are decoded as a stream and only whole lines are yielded.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const dataOf = (line: string) => (line.startsWith('data:') ? line.slice(5).trim() : null);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const data = dataOf(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (data !== null) yield data;
        newline = buffer.indexOf('\n');
      }
    }
    // A last line the provider didn't end with a newline.
    const data = dataOf(buffer + decoder.decode());
    if (data !== null) yield data;
  } finally {
    // Also when the caller stops early (her "עצירה"): tell the network we're done.
    await reader.cancel().catch(() => undefined);
  }
}
