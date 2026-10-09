/** Bound the entire response read, including JSON decoding, without cancelling sibling signals. */
export async function boundedRead<T>(read: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, timeoutMs = 20_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      controller.abort();
      reject(new DOMException('Refresh superseded', 'AbortError'));
    };
    parent.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Live data request timed out. Try refreshing again.'));
    }, timeoutMs);
    if (parent.aborted) abort();
  });
  try {
    if (parent.aborted) return await cancelled;
    return await Promise.race([read(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', abort);
  }
}
