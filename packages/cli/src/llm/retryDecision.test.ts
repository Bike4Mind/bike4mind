import { describe, it, expect } from 'vitest';
import { ModelCallError, type ModelCallErrorKind } from './modelCallError';
import { decideRetry, EmptyCompletionError, MAX_RETRIES, MAX_RETRY_AFTER_MS } from './retryDecision';

const midJitter = () => 0.5;
const delayOf = (error: unknown, attempt: number, random: () => number = midJitter): number => {
  const decision = decideRetry(error, attempt, random);
  if (!decision.retry) throw new Error('expected a retry');
  return decision.delayMs;
};

describe('decideRetry', () => {
  it.each<[ModelCallErrorKind, number]>([
    ['unreachable', 500],
    ['network', 500],
    ['stream_idle', 500],
    ['rate_limited', 2_000],
    ['overloaded', 2_000],
    ['server', 2_000],
  ])('retries %s from a %dms base', (kind, base) => {
    expect(delayOf(new ModelCallError(kind, 'x'), 0)).toBe(base);
  });

  it('retries an empty completion like a dropped connection', () => {
    expect(delayOf(new EmptyCompletionError(), 0)).toBe(500);
  });

  it.each<ModelCallErrorKind>(['auth', 'refused'])('does not retry %s', kind => {
    expect(decideRetry(new ModelCallError(kind, 'x'), 0)).toEqual({ retry: false });
  });

  it('does not retry an unclassified error', () => {
    expect(decideRetry(new Error('Authentication failed'), 0)).toEqual({ retry: false });
  });

  it('classifies a raw socket error by its code, not its message', () => {
    const aborted = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    expect(delayOf(aborted, 0)).toBe(500);
    expect(decideRetry(new Error('aborted'), 0)).toEqual({ retry: false });
  });

  it('doubles the delay per attempt', () => {
    const error = new ModelCallError('server', 'x');
    expect([0, 1, 2].map(attempt => delayOf(error, attempt))).toEqual([2_000, 4_000, 8_000]);
  });

  it('jitters each delay by up to 20% either way', () => {
    const error = new ModelCallError('network', 'x');
    expect(delayOf(error, 0, () => 0)).toBe(400);
    expect(delayOf(error, 0, () => 1)).toBe(600);
  });

  it(`stops after ${MAX_RETRIES} retries`, () => {
    const error = new ModelCallError('network', 'x');
    expect(decideRetry(error, MAX_RETRIES - 1).retry).toBe(true);
    expect(decideRetry(error, MAX_RETRIES)).toEqual({ retry: false });
  });

  it('waits at least the Retry-After the server asked for', () => {
    const error = new ModelCallError('rate_limited', 'x', { retryAfterMs: 12_000 });
    expect(delayOf(error, 0, () => 1)).toBe(12_000);
  });

  it('keeps its own backoff when it is longer than Retry-After', () => {
    const error = new ModelCallError('rate_limited', 'x', { retryAfterMs: 1_000 });
    expect(delayOf(error, 1)).toBe(4_000);
  });

  it('surfaces a Retry-After too long to wait out instead of retrying', () => {
    const error = new ModelCallError('rate_limited', 'x', { retryAfterMs: MAX_RETRY_AFTER_MS + 1 });
    expect(decideRetry(error, 0)).toEqual({ retry: false });
  });
});
