import { describe, expect, it } from 'vitest';
import {
  LlmTimeoutError,
  createAnthropicRequestTimeoutError,
  createAnthropicStreamTimeoutError,
  isLlmTimeoutError,
} from './llmTimeoutErrors';

describe('LlmTimeoutError', () => {
  it.each([
    createAnthropicStreamTimeoutError('stream_idle', 90_000),
    createAnthropicStreamTimeoutError('first_event', 30_000),
    createAnthropicRequestTimeoutError(60_000),
  ])('words $kind without overload or abort language', error => {
    const message = error.message.toLowerCase();
    // "overloaded" would route it into the busy retry; "aborted" would read as a user cancel.
    expect(message).not.toContain('overload');
    expect(message).not.toContain('aborted');
  });

  it('keeps the phrases the message-based predicates and final-error mapping still match', () => {
    expect(createAnthropicStreamTimeoutError('stream_idle', 180_000).message).toContain('stream timeout');
    expect(createAnthropicStreamTimeoutError('stream_idle', 180_000).message).toContain('180 seconds');
    expect(createAnthropicRequestTimeoutError(60_000).message).toContain('request timeout');
  });

  it('recognizes a copy from another bundle by name', () => {
    const foreign = Object.assign(new Error('stream timeout'), { name: 'LlmTimeoutError', kind: 'stream_idle' });
    expect(isLlmTimeoutError(foreign)).toBe(true);
    expect(isLlmTimeoutError(new LlmTimeoutError('request', 1, 'x'))).toBe(true);
    expect(isLlmTimeoutError(new Error('stream timeout'))).toBe(false);
  });
});
