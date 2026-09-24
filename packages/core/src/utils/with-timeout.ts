export async function withTimeoutReject<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => Promise<void>
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void Promise.resolve()
        .then(() => onTimeout?.())
        .catch(() => undefined)
        .finally(() => {
          reject(new Error(message));
        });
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (timedOut) {
      void promise.catch(() => undefined);
    }
  }
}
