/**
 * Universal SSE & NDJSON Stream Reader Utility
 *
 * Parses ReadableStream chunks from fetch() responses into line-delimited
 * SSE ('data: ...') or NDJSON payloads without external dependencies.
 * Supports immediate cancellation via AbortSignal and cancels the underlying stream in finally.
 */

export async function* readStreamLines(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  if (!body) return;
  if (signal?.aborted) {
    const abortErr = new Error('Stream aborted by caller');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const onAbort = () => {
    reader.cancel().catch(() => {});
  };

  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      if (signal?.aborted) {
        const abortErr = new Error('Stream aborted by caller');
        abortErr.name = 'AbortError';
        throw abortErr;
      }

      const { value, done } = await reader.read();
      if (signal?.aborted) {
        const abortErr = new Error('Stream aborted by caller');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
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
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
    await reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch { }
  }
}
