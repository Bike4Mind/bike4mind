import { describe, it, expect } from 'vitest';
import { normalizeGeminiFinishReason, normalizeOllamaDoneReason, normalizeOpenAIFinishReason } from './stopReason';

describe('normalizeOpenAIFinishReason', () => {
  it('maps a truncated completion to max_tokens', () => {
    expect(normalizeOpenAIFinishReason('length')).toBe('max_tokens');
  });

  it('maps tool-call finishes to tool_use', () => {
    expect(normalizeOpenAIFinishReason('tool_calls')).toBe('tool_use');
    expect(normalizeOpenAIFinishReason('function_call')).toBe('tool_use');
  });

  it('passes a clean stop through unchanged', () => {
    expect(normalizeOpenAIFinishReason('stop')).toBe('stop');
  });

  it('returns undefined for a missing reason', () => {
    expect(normalizeOpenAIFinishReason(undefined)).toBeUndefined();
    expect(normalizeOpenAIFinishReason(null)).toBeUndefined();
  });
});

describe('normalizeGeminiFinishReason', () => {
  it('maps a truncated completion to max_tokens', () => {
    expect(normalizeGeminiFinishReason('MAX_TOKENS')).toBe('max_tokens');
  });

  it('maps a clean STOP to stop', () => {
    expect(normalizeGeminiFinishReason('STOP')).toBe('stop');
  });

  it('returns undefined for a missing reason', () => {
    expect(normalizeGeminiFinishReason(undefined)).toBeUndefined();
  });
});

describe('normalizeOllamaDoneReason', () => {
  it('maps a truncated completion to max_tokens', () => {
    expect(normalizeOllamaDoneReason('length')).toBe('max_tokens');
  });

  it('maps a clean stop through unchanged', () => {
    expect(normalizeOllamaDoneReason('stop')).toBe('stop');
  });

  it('returns undefined for a missing reason', () => {
    expect(normalizeOllamaDoneReason(undefined)).toBeUndefined();
  });
});
