const DEADLOCK_ERRNO = 1213;
const LOCK_WAIT_TIMEOUT_ERRNO = 1205;

export function isRetryableLockError(error: unknown): boolean {
  const code = readErrorField(error, "code");
  if (code === "ER_LOCK_DEADLOCK" || code === "ER_LOCK_WAIT_TIMEOUT") {
    return true;
  }

  const errno = Number(readErrorField(error, "errno"));
  if (errno === DEADLOCK_ERRNO || errno === LOCK_WAIT_TIMEOUT_ERRNO) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  return /deadlock found when trying to get lock/i.test(message) || /lock wait timeout exceeded/i.test(message);
}

export async function withDeadlockRetry<T>(
  operation: () => Promise<T>,
  options?: { attempts?: number; baseDelayMs?: number }
): Promise<T> {
  const attempts = Math.max(1, options?.attempts ?? 4);
  const baseDelayMs = Math.max(10, options?.baseDelayMs ?? 80);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableLockError(error) || attempt >= attempts) {
        throw error;
      }
      const jitter = Math.floor(Math.random() * baseDelayMs);
      await sleep(baseDelayMs * 2 ** (attempt - 1) + jitter);
    }
  }

  throw lastError;
}

function readErrorField(error: unknown, field: "code" | "errno"): unknown {
  if (!error || typeof error !== "object" || !(field in error)) {
    return undefined;
  }
  return (error as Record<string, unknown>)[field];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
