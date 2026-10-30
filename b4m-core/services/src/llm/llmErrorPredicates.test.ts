import { describe, expect, it } from 'vitest';
import {
  LlmTimeoutError,
  bedrockEmptyResponseMessage,
  createAnthropicRequestTimeoutError,
  createAnthropicStreamTimeoutError,
} from '@bike4mind/llm-adapters';
import {
  isRequestTimeoutError,
  isSlowModelTimeoutError,
  isStreamIdleTimeoutError,
  isTruncatedStreamError,
} from './llmErrorPredicates';

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

  it('tells a truncated stream apart from a slow one', () => {
    const anthropic = new Error('Anthropic API stream timeout - the stream ended after 3 events without message_stop');
    const bedrock = new Error('[BaseBedrockBackend] stream timeout - model "m" ended without a terminal event');

    for (const truncated of [anthropic, bedrock]) {
      expect(isTruncatedStreamError(truncated)).toBe(true);
      expect(isSlowModelTimeoutError(truncated)).toBe(false);
    }
    expect(isTruncatedStreamError(createAnthropicStreamTimeoutError('stream_idle', 90_000))).toBe(false);
  });

  it('retries a stalled empty Bedrock stream but not a deterministic empty one', () => {
    const stalled = new Error(bedrockEmptyResponseMessage('m', 'r', true));
    const deterministic = new Error(bedrockEmptyResponseMessage('m', 'r', false));

    expect(isStreamIdleTimeoutError(stalled)).toBe(true);
    expect(isTruncatedStreamError(stalled)).toBe(false);
    expect(isStreamIdleTimeoutError(deterministic)).toBe(false);
    expect(isTruncatedStreamError(deterministic)).toBe(false);
  });
});
