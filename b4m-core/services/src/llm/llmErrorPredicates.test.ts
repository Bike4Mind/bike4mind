import { describe, expect, it } from 'vitest';
import {
  LlmTimeoutError,
  createAnthropicRequestTimeoutError,
  createAnthropicStreamTimeoutError,
} from '@bike4mind/llm-adapters';
import { isRequestTimeoutError, isSlowModelTimeoutError, isStreamIdleTimeoutError } from './llmErrorPredicates';

describe('timeout predicates', () => {
  it('reads the typed kind rather than the message', () => {
    const idle = new LlmTimeoutError('stream_idle', 90_000, 'no recognizable phrase');
    const request = new LlmTimeoutError('request', 60_000, 'no recognizable phrase');

    expect(isStreamIdleTimeoutError(idle)).toBe(true);
    expect(isRequestTimeoutError(idle)).toBe(false);
    expect(isRequestTimeoutError(request)).toBe(true);
    expect(isStreamIdleTimeoutError(request)).toBe(false);
  });

  it('counts a first-event timeout as a stream stall', () => {
    expect(isStreamIdleTimeoutError(createAnthropicStreamTimeoutError('first_event', 30_000))).toBe(true);
  });

  it('still matches untyped errors by message, such as the truncation rejection', () => {
    const truncated = new Error('Anthropic API stream timeout - the stream ended after 3 events without message_stop');
    expect(isStreamIdleTimeoutError(truncated)).toBe(true);
    expect(isRequestTimeoutError(new Error('Request timeout after 60s'))).toBe(true);
  });

  it('treats every timeout as slow and nothing else', () => {
    expect(isSlowModelTimeoutError(createAnthropicStreamTimeoutError('stream_idle', 90_000))).toBe(true);
    expect(isSlowModelTimeoutError(createAnthropicRequestTimeoutError(60_000))).toBe(true);
    expect(isSlowModelTimeoutError(new Error('Anthropic API is overloaded'))).toBe(false);
  });
});
