import { describe, expect, it } from 'vitest';
import { MAX_RECORDED_TURN_RETRIES, type ITurnRetry, type ITurnTiming } from '@bike4mind/common';
import { formatDuration } from './formatDuration';
import { isNotableTurn, summarizeTurnTiming, turnTimingMarkdown } from './turnTimingFormat';

const retry = (overrides: Partial<ITurnRetry> = {}): ITurnRetry => ({
  reason: 'stream_idle_timeout',
  delayMs: 3500,
  model: 'claude-opus-5-5',
  at: new Date('2026-10-21T02:21:46.000Z'),
  ...overrides,
});

const timing = (overrides: Partial<ITurnTiming> = {}): ITurnTiming => ({
  queueMs: 120,
  semaphoreWaitMs: 0,
  retries: [],
  fallbackHops: 0,
  ...overrides,
});

describe('isNotableTurn', () => {
  it('is false for a fast, clean turn and for a turn with no record', () => {
    expect(isNotableTurn(timing({ totalMs: 4000 }))).toBe(false);
    expect(isNotableTurn(undefined)).toBe(false);
  });

  it('is true once the turn retried, fell back, or ran past a minute', () => {
    expect(isNotableTurn(timing({ retries: [retry()] }))).toBe(true);
    expect(isNotableTurn(timing({ fallbackHops: 1 }))).toBe(true);
    expect(isNotableTurn(timing({ totalMs: 60_000 }))).toBe(true);
  });
});

describe('formatDuration', () => {
  // Shared with the Status Timeline in the same panel, so one turn reads the same in both.
  it.each([
    [999, '999ms'],
    [1240, '1.2s'],
    [9999, '10.0s'],
    [415_000, '6m 55s'],
  ])('formats %s as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('summarizeTurnTiming', () => {
  it('reads the incident turn as stalled, not busy, and folds repeated reasons', () => {
    const summary = summarizeTurnTiming(
      timing({ totalMs: 415_000, retries: [retry(), retry(), retry({ reason: 'overloaded' })] })
    );

    expect(summary).toBe('Took 6m 55s - 3 retries (response stalled, provider busy)');
  });

  it('reads a full retry list as a lower bound, since the recorder stops at the cap', () => {
    const retries = Array.from({ length: MAX_RECORDED_TURN_RETRIES }, () => retry());

    expect(summarizeTurnTiming(timing({ retries }))).toContain(`${MAX_RECORDED_TURN_RETRIES}+ retries`);
  });

  it('names fallback hops and omits the total while the turn is still running', () => {
    expect(summarizeTurnTiming(timing({ retries: [retry()], fallbackHops: 1 }))).toBe(
      '1 retry (response stalled) - 1 model switch'
    );
  });
});

describe('turnTimingMarkdown', () => {
  it('lists each retry with its status and request id', () => {
    const markdown = turnTimingMarkdown(
      timing({ retries: [retry({ reason: 'rate_limit', status: 429, requestId: 'req_1', retryAfterMs: 2000 })] })
    );

    expect(markdown).toContain('## Turn Timing');
    expect(markdown).toContain(
      '2026-10-21T02:21:46.000Z rate_limit on claude-opus-5-5, waited 3500 ms (status 429, retry-after 2000 ms, request req_1)'
    );
  });

  it('says so when the turn has no record', () => {
    expect(turnTimingMarkdown(undefined)).toContain('not recorded');
  });
});
