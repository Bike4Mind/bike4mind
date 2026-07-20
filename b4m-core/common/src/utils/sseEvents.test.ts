import { describe, it, expect } from 'vitest';
import { buildMetaEvent, buildPublicSSEEvent, formatSSEError, serializeSSEEvent } from './sseEvents';

describe('buildPublicSSEEvent', () => {
  it('passes assistant text and usage/credits through', () => {
    const e = buildPublicSSEEvent(['', 'the answer'], {
      inputTokens: 10,
      outputTokens: 5,
      creditsUsed: 2,
    });
    expect(e.text).toBe('the answer');
    expect(e.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(e.credits).toMatchObject({ used: 2 });
  });

  it('redacts tool calls, thinking, and responseFormatMode from a public caller', () => {
    const e = buildPublicSSEEvent(['reasoning here', 'the answer'], {
      outputTokens: 5,
      toolsUsed: [{ name: 'search_knowledge_base', arguments: { query: 'secret' }, id: 't1' } as never],
      thinking: ['internal chain of thought'],
      responseFormatMode: 'json' as never,
    });
    expect(e.type).toBe('content'); // not 'tool_use'
    expect(e.tools).toBeUndefined();
    expect(e.thinking).toBeUndefined();
    expect(e.responseFormatMode).toBeUndefined();
    // The thinking channel (text[0]) must not leak via the text fallback.
    expect(e.text).toBe('the answer');
  });

  it('does not leak the thinking channel when the response channel is empty', () => {
    const e = buildPublicSSEEvent(['internal thinking'], { outputTokens: 1 });
    expect(e.text).toBe('');
  });
});

describe('buildMetaEvent', () => {
  it('builds a meta event carrying the request id', () => {
    expect(buildMetaEvent('req-123')).toEqual({ type: 'meta', requestId: 'req-123' });
  });
});

describe('formatSSEError', () => {
  it('includes the request id when provided', () => {
    expect(formatSSEError(new Error('boom'), 'req-123')).toEqual({
      type: 'error',
      message: 'boom',
      requestId: 'req-123',
    });
  });

  it('omits the request id field when not provided', () => {
    const event = formatSSEError(new Error('boom'));
    expect(event).toEqual({ type: 'error', message: 'boom' });
    expect('requestId' in event).toBe(false);
  });

  it('falls back to a generic message for non-Error input', () => {
    expect(formatSSEError('weird', 'req-9').message).toBe('Internal server error');
  });
});

describe('serializeSSEEvent', () => {
  it('serializes a meta event as an SSE data line', () => {
    expect(serializeSSEEvent(buildMetaEvent('req-123'))).toBe('data: {"type":"meta","requestId":"req-123"}\n\n');
  });
});
