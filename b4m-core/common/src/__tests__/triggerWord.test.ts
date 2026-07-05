import { describe, it, expect } from 'vitest';
import {
  triggerWordSchema,
  triggerWordsSchema,
  validateTriggerWord,
  TRIGGER_WORD_ERROR_MESSAGE,
} from '../utils/triggerWord';

describe('triggerWordSchema', () => {
  it.each([
    ['@a', 'minimum length'],
    ['@bob', 'simple alphanumeric'],
    ['@research-lead', 'single hyphen — the case the old regex broke on'],
    ['@brand-voice-writer', 'multiple hyphens'],
    ['@under_score', 'underscores'],
    ['@MixedCase', 'mixed case'],
    ['@123', 'all-digit body'],
    ['@a'.padEnd(32, 'x'), 'max length (32 chars total)'],
  ])('accepts %s (%s)', (value: string) => {
    expect(triggerWordSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['bob', 'missing @'],
    ['@', 'empty body'],
    ['@-foo', 'leading hyphen in body'],
    ['@foo-', 'trailing hyphen in body'],
    ['@hey,', 'punctuation'],
    ['@foo bar', 'whitespace'],
    ['@foo@bar', 'embedded @'],
    ['@'.padEnd(33, 'x'), 'over 32 chars'],
  ])('rejects %s (%s)', (value: string) => {
    expect(triggerWordSchema.safeParse(value).success).toBe(false);
  });
});

describe('triggerWordsSchema', () => {
  it('accepts an empty array — agents may omit trigger words and still function via direct invocation', () => {
    expect(triggerWordsSchema.safeParse([]).success).toBe(true);
  });

  it('accepts up to 20 trigger words', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `@trigger${i}`);
    expect(triggerWordsSchema.safeParse(twenty).success).toBe(true);
  });

  it('rejects more than 20 trigger words', () => {
    const twentyOne = Array.from({ length: 21 }, (_, i) => `@trigger${i}`);
    expect(triggerWordsSchema.safeParse(twentyOne).success).toBe(false);
  });

  it('rejects an array containing one bad entry — all-or-nothing', () => {
    expect(triggerWordsSchema.safeParse(['@valid', '@-leading-hyphen']).success).toBe(false);
  });

  it('rejects null — callers must pass an array, never null', () => {
    // The agent form/API contract treats `triggerWords` as an array; null
    // would have to be coerced upstream. Failing the schema is the right
    // signal that the caller is misusing it.
    expect(triggerWordsSchema.safeParse(null).success).toBe(false);
  });

  it('dedupes case-insensitively and normalizes to lowercase', () => {
    const result = triggerWordsSchema.safeParse(['@Bob', '@bob']);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(['@bob']);
    }
  });

  it('preserves order on dedup — first occurrence wins, all lowercased', () => {
    const result = triggerWordsSchema.safeParse(['@Alice', '@bob', '@ALICE', '@Carol']);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(['@alice', '@bob', '@carol']);
    }
  });
});

describe('validateTriggerWord', () => {
  it('returns ok=true with the value on valid input', () => {
    expect(validateTriggerWord('@research-lead')).toEqual({ ok: true, value: '@research-lead' });
  });

  it('returns ok=false with a non-empty error message on invalid input', () => {
    const result = validateTriggerWord('@-broken');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(TRIGGER_WORD_ERROR_MESSAGE);
    }
  });
});
