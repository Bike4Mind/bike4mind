import { describe, it, expect } from 'vitest';
import {
  classifyStage,
  FEEDBACK_ROLLUP_MAX_WINDOW_DAYS,
  FeedbackRollupQuerySchema,
  parseFeedbackRollupBound,
} from './FeedbackTypes';

describe('classifyStage', () => {
  it('classifies production as production', () => {
    expect(classifyStage('production')).toBe('production');
  });

  it('classifies every other stage as nonprod', () => {
    expect(classifyStage('staging')).toBe('nonprod');
    expect(classifyStage('dev')).toBe('nonprod');
    expect(classifyStage('some-preview-stage')).toBe('nonprod');
  });

  it('classifies undefined as nonprod', () => {
    expect(classifyStage(undefined)).toBe('nonprod');
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const at = (offsetDays: number) => new Date(BASE + offsetDays * DAY_MS).toISOString();

describe('parseFeedbackRollupBound', () => {
  it('reads an offset-less value as UTC rather than as the host timezone', () => {
    expect(parseFeedbackRollupBound('2026-01-01T00:00:00').toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('honours an explicit offset', () => {
    expect(parseFeedbackRollupBound('2026-01-01T02:00:00+02:00').toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('FeedbackRollupQuerySchema', () => {
  it('accepts a UTC window', () => {
    expect(FeedbackRollupQuerySchema.safeParse({ from: at(0), to: at(30) }).success).toBe(true);
  });

  it('accepts the offset-less and offset-bearing forms a date picker emits', () => {
    expect(
      FeedbackRollupQuerySchema.safeParse({ from: '2026-01-01T00:00:00', to: '2026-01-31T00:00:00' }).success
    ).toBe(true);
    expect(
      FeedbackRollupQuerySchema.safeParse({ from: '2026-01-01T00:00:00+02:00', to: '2026-01-31T00:00:00+02:00' })
        .success
    ).toBe(true);
  });

  it('rejects a missing bound', () => {
    const missingFrom = FeedbackRollupQuerySchema.safeParse({ to: at(30) });
    const missingTo = FeedbackRollupQuerySchema.safeParse({ from: at(0) });

    expect(missingFrom.success).toBe(false);
    expect(missingFrom.error).not.toBe(undefined);
    expect(missingTo.success).toBe(false);
    expect(missingTo.error).not.toBe(undefined);
  });

  it('rejects a reversed window', () => {
    expect(FeedbackRollupQuerySchema.safeParse({ from: at(30), to: at(0) }).success).toBe(false);
  });

  it('rejects an empty window - the bound comparison is strict, so from === to is not a window', () => {
    expect(FeedbackRollupQuerySchema.safeParse({ from: at(0), to: at(0) }).success).toBe(false);
  });

  it('rejects a non-date string', () => {
    const result = FeedbackRollupQuerySchema.safeParse({ from: 'last tuesday', to: at(30) });
    expect(result.success).toBe(false);
    expect(result.error).not.toBe(undefined);
  });

  it('accepts a window longer than the 90-day text retention - retention is reported, never enforced here', () => {
    expect(FeedbackRollupQuerySchema.safeParse({ from: at(0), to: at(120) }).success).toBe(true);
  });

  it('accepts a window at exactly the cap and rejects one past it', () => {
    expect(FeedbackRollupQuerySchema.safeParse({ from: at(0), to: at(FEEDBACK_ROLLUP_MAX_WINDOW_DAYS) }).success).toBe(
      true
    );
    expect(
      FeedbackRollupQuerySchema.safeParse({ from: at(0), to: at(FEEDBACK_ROLLUP_MAX_WINDOW_DAYS + 1) }).success
    ).toBe(false);
  });

  it('strips a userId the caller tried to smuggle in - the principal is never taken from the query', () => {
    const result = FeedbackRollupQuerySchema.safeParse({ from: at(0), to: at(30), userId: 'someone-else' });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('userId');
  });
});
