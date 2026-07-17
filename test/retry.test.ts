import { describe, expect, it, vi } from 'vitest';
import { HttpError, defaultIsRetryable, getStatusCode, withRetry } from '../src/lib/retry';

const noSleep = async (): Promise<void> => undefined;

describe('withRetry', () => {
  it('returns the first successful result', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 500 up to 3 attempts then throws', async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError('boom', 500, ''));
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries on 429 and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpError('rate limited', 429, ''))
      .mockResolvedValue('ok');
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 400', async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError('bad request', 400, ''));
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 410', async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError('gone', 410, ''));
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow('gone');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries plain network errors', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue('ok');
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('backs off exponentially', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      delays.push(ms);
    };
    const fn = vi.fn().mockRejectedValue(new HttpError('boom', 500, ''));
    await expect(withRetry(fn, { sleep, baseDelayMs: 100 })).rejects.toThrow('boom');
    expect(delays).toEqual([100, 200]);
  });
});

describe('getStatusCode', () => {
  it('reads status from HttpError', () => {
    expect(getStatusCode(new HttpError('x', 503, ''))).toBe(503);
  });

  it('reads nested response.status (googleapis shape)', () => {
    expect(getStatusCode({ response: { status: 410 } })).toBe(410);
  });

  it('reads statusCode (common SDK error shape)', () => {
    expect(getStatusCode({ statusCode: 429 })).toBe(429);
  });

  it('returns null for plain errors', () => {
    expect(getStatusCode(new Error('nope'))).toBeNull();
  });
});

describe('defaultIsRetryable', () => {
  it('treats status-less errors as retryable network errors', () => {
    expect(defaultIsRetryable(new Error('ECONNRESET'))).toBe(true);
  });

  it('does not retry 4xx other than 429', () => {
    expect(defaultIsRetryable(new HttpError('x', 404, ''))).toBe(false);
    expect(defaultIsRetryable(new HttpError('x', 429, ''))).toBe(true);
  });
});
