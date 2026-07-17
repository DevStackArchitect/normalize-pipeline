export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function getStatusCode(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const obj = err as Record<string, unknown>;
  for (const key of ['status', 'statusCode', 'code']) {
    const value = obj[key];
    if (typeof value === 'number') return value;
  }
  const response = obj['response'];
  if (typeof response === 'object' && response !== null) {
    const status = (response as Record<string, unknown>)['status'];
    if (typeof status === 'number') return status;
  }
  return null;
}

export function defaultIsRetryable(err: unknown): boolean {
  const status = getStatusCode(err);
  if (status === null) return true;
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  isRetryable?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryable(err)) throw err;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}
