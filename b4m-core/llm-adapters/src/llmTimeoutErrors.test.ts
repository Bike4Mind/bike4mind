import { describe, expect, it } from 'vitest';
import {
  LlmTimeoutError,
  createAnthropicRequestTimeoutError,
  createAnthropicStreamTimeoutError,
  isKeepaliveStreamTimeout,
  isLlmTimeoutError,
} from './llmTimeoutErrors';

describe('LlmTimeoutError', () => {
  it.each([
    createAnthropicStreamTimeoutError('stream_idle', 90_000),
    createAnthropicStreamTimeoutError('first_event', 30_000),
    createAnthropicStreamTimeoutError('stream_idle', 1_280_000, { keepalive: true }),
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

  it('defaults keepalive to false and carries no usage unless given', () => {
    const error = createAnthropicStreamTimeoutError('stream_idle', 90_000);
    expect(error.keepalive).toBe(false);
    expect(error.usage).toBeUndefined();
    expect(new LlmTimeoutError('request', 1, 'x').keepalive).toBe(false);
  });

  it('says a keepalive timeout found the connection alive, in words the predicates still match', () => {
    const usage = { inputTokens: 1200, cacheReadInputTokens: 40_000, cacheCreationInputTokens: 300 };
    const error = createAnthropicStreamTimeoutError('stream_idle', 1_280_000, { keepalive: true, usage });

    expect(error).toMatchObject({ kind: 'stream_idle', timeoutMs: 1_280_000, keepalive: true, usage });
    expect(error.message).toContain('stream timeout');
    expect(error.message).toContain('1280 seconds');
    expect(error.message).toContain('connection stayed alive');
    // Mirrors the SKIP rule in apps/workers/src/events/logToSlackClassify.ts.
    expect(error.message).toMatch(/stream timeout - no (?:response|event) received/i);
  });

  it('flags only keepalive timeouts as keepalive', () => {
    expect(isKeepaliveStreamTimeout(createAnthropicStreamTimeoutError('stream_idle', 1, { keepalive: true }))).toBe(
      true
    );
    expect(isKeepaliveStreamTimeout(createAnthropicStreamTimeoutError('stream_idle', 180_000))).toBe(false);
    expect(isKeepaliveStreamTimeout(Object.assign(new Error('stream timeout'), { keepalive: true }))).toBe(false);
    expect(isKeepaliveStreamTimeout(undefined)).toBe(false);
  });

  it('recognizes a copy from another bundle by name', () => {
    const foreign = Object.assign(new Error('stream timeout'), { name: 'LlmTimeoutError', kind: 'stream_idle' });
    expect(isLlmTimeoutError(foreign)).toBe(true);
    expect(isLlmTimeoutError(new LlmTimeoutError('request', 1, 'x'))).toBe(true);
    expect(isLlmTimeoutError(new Error('stream timeout'))).toBe(false);
  });
});
