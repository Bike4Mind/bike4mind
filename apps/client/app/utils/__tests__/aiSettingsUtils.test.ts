import { describe, it, expect } from 'vitest';
import { computeDefaultMaxTokens } from '../aiSettingsUtils';

describe('computeDefaultMaxTokens', () => {
  it('falls back to the catalog max_tokens when contextWindow is missing/0', () => {
    // Tier logic needs a context window - without it, defer to the model author's intent.
    expect(computeDefaultMaxTokens({ contextWindow: 0, max_tokens: 16384 })).toBe(16384);
  });

  it('returns 0 when max_tokens is 0', () => {
    expect(computeDefaultMaxTokens({ contextWindow: 128000, max_tokens: 0 })).toBe(0);
  });

  it('halves the context window for small-context models (ctx ≤ 8192)', () => {
    // ctx 8192, max 4096: halve to 4096, capped by model max -> 4096
    expect(computeDefaultMaxTokens({ contextWindow: 8192, max_tokens: 4096 })).toBe(4096);
    // ctx 4096, max 4096: halve to 2048
    expect(computeDefaultMaxTokens({ contextWindow: 4096, max_tokens: 4096 })).toBe(2048);
  });

  it('caps at 8192 for medium-context models (8192 < ctx ≤ 32768)', () => {
    expect(computeDefaultMaxTokens({ contextWindow: 16000, max_tokens: 16384 })).toBe(8192);
    expect(computeDefaultMaxTokens({ contextWindow: 32768, max_tokens: 16384 })).toBe(8192);
  });

  it('caps at 16384 for large-context models (ctx > 32768)', () => {
    // GPT-5.2 Chat Latest: ctx 128k, max 16k -> 16384
    expect(computeDefaultMaxTokens({ contextWindow: 128000, max_tokens: 16384 })).toBe(16384);
    // GPT-5.2: ctx 400k, max 128k -> 16384 (the bug scenario)
    expect(computeDefaultMaxTokens({ contextWindow: 400000, max_tokens: 128000 })).toBe(16384);
  });

  it('respects model max_tokens when it is lower than the tier cap', () => {
    // ctx 200k, max 4096 -> 4096
    expect(computeDefaultMaxTokens({ contextWindow: 200000, max_tokens: 4096 })).toBe(4096);
  });

  it('floors fractional results from the halving branch', () => {
    // ctx 4097, max 4097: halve to 2048.5 -> 2048
    expect(computeDefaultMaxTokens({ contextWindow: 4097, max_tokens: 4097 })).toBe(2048);
  });
});
