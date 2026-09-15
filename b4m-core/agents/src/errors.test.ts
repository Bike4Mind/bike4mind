import { describe, it, expect } from 'vitest';
import { isContextLimitError } from './errors';

describe('isContextLimitError', () => {
  it('matches the Anthropic prompt-too-long message', () => {
    expect(isContextLimitError(new Error('prompt is too long: 250000 tokens > 200000 maximum'))).toBe(true);
  });

  it('matches the OpenAI maximum-context-length message', () => {
    expect(
      isContextLimitError(
        new Error(
          "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens."
        )
      )
    ).toBe(true);
  });

  it('matches the OpenAI context_length_exceeded code', () => {
    expect(isContextLimitError(new Error('context_length_exceeded'))).toBe(true);
  });

  it('matches the Bedrock synthetic context-overflow message', () => {
    expect(
      isContextLimitError(
        new Error(
          'Context overflow: the conversation is too long for the current model x: ~5000 estimated input tokens + 100 reserved output tokens > 4096 context window. Please start a new quest or shorten the conversation.'
        )
      )
    ).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isContextLimitError(new Error('PROMPT IS TOO LONG'))).toBe(true);
  });

  it('matches a message nested under error.error.message', () => {
    expect(isContextLimitError({ error: { message: 'maximum context length exceeded' } })).toBe(true);
  });

  it('matches a message reachable via a cause chain', () => {
    const inner = new Error('context_length_exceeded');
    const outer = new Error('request failed', { cause: inner });
    expect(isContextLimitError(outer)).toBe(true);
  });

  it('matches a plain string error', () => {
    expect(isContextLimitError('input is too long for this model')).toBe(true);
  });

  it('returns false for an auth error', () => {
    expect(isContextLimitError(new Error('Authentication failed: invalid API key'))).toBe(false);
  });

  it('returns false for a network error', () => {
    expect(isContextLimitError(new Error('ETIMEDOUT: connection timed out'))).toBe(false);
  });

  it('returns false for an abort error', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(isContextLimitError(err)).toBe(false);
  });

  it('returns false for a permission-denied error', () => {
    expect(isContextLimitError(new Error("Permission denied for tool 'bash'"))).toBe(false);
  });

  it('returns false for undefined/null', () => {
    expect(isContextLimitError(undefined)).toBe(false);
    expect(isContextLimitError(null)).toBe(false);
  });
});
