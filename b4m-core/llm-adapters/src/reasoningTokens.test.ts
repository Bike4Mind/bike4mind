import { describe, it, expect } from 'vitest';
import { addReasoningTokens, reasoningTokensField, reasoningTokensFromUsage } from './reasoningTokens';

describe('reasoningTokensFromUsage', () => {
  it.each([
    ['Anthropic', { output_tokens: 800, output_tokens_details: { thinking_tokens: 780 } }, 780],
    ['OpenAI chat', { completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 32 } }, 32],
    ['OpenAI Responses', { output_tokens: 50, output_tokens_details: { reasoning_tokens: 40 } }, 40],
    ['Gemini', { candidatesTokenCount: 18, thoughtsTokenCount: 543 }, 543],
    ['a reported zero', { completion_tokens_details: { reasoning_tokens: 0 } }, 0],
  ])('reads the %s spelling', (_label, usage, expected) => {
    expect(reasoningTokensFromUsage(usage)).toBe(expected);
  });

  it.each([
    ['no usage', undefined],
    ['usage without a breakdown', { input_tokens: 10, output_tokens: 4 }],
    ['a null Anthropic count', { output_tokens_details: { thinking_tokens: null } }],
    ['a null details object', { completion_tokens_details: null }],
    ['a negative count', { thoughtsTokenCount: -1 }],
    ['a non-numeric count', { thoughtsTokenCount: '12' }],
  ])('returns undefined for %s', (_label, usage) => {
    expect(reasoningTokensFromUsage(usage)).toBeUndefined();
  });
});

describe('addReasoningTokens', () => {
  it('stays undefined until a turn reports a count', () => {
    expect(addReasoningTokens(undefined, undefined)).toBeUndefined();
  });

  it('keeps whichever side reported', () => {
    expect(addReasoningTokens(undefined, 5)).toBe(5);
    expect(addReasoningTokens(5, undefined)).toBe(5);
  });

  it('sums two reported counts', () => {
    expect(addReasoningTokens(5, 7)).toBe(12);
  });
});

describe('reasoningTokensField', () => {
  it('leaves the key absent for an unreported count', () => {
    expect(reasoningTokensField(undefined)).toEqual({});
    expect(reasoningTokensField(undefined)).not.toHaveProperty('reasoningTokens');
  });

  it('carries a reported count, including zero', () => {
    expect(reasoningTokensField(0)).toEqual({ reasoningTokens: 0 });
  });
});
