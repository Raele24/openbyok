/**
 * Universal SSE & NDJSON Stream Reader Utility
 *
 * Parses ReadableStream chunks from fetch() responses into line-delimited
 * SSE ('data: ...') or NDJSON payloads without external dependencies.
 */

export async function* readStreamLines(
  body: ReadableStream<Uint8Array> | null
): AsyncGenerator<string, void, unknown> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          yield trimmed;
        }
      }
    }
    if (buffer.trim()) {
      yield buffer.trim();
    }
  } finally {
    reader.releaseLock();
  }
}

