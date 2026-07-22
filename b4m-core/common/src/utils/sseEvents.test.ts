import { describe, it, expect } from 'vitest';
import { buildMetaEvent, buildPublicSSEEvent, buildSSEEvent, formatSSEError, serializeSSEEvent } from './sseEvents';

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

  it('drops usdCost while keeping creditsUsed', () => {
    const e = buildPublicSSEEvent(['', 'the answer'], { creditsUsed: 2, usdCost: 0.0123 });
    expect(e.credits).toMatchObject({ used: 2 });
    expect(e.credits?.usdCost).toBeUndefined();
    // The wire frame must not carry the key at all, not just an undefined value.
    expect(serializeSSEEvent(e)).not.toContain('usdCost');
  });

  it('emits no credits block when usdCost is the only credit field', () => {
    const e = buildPublicSSEEvent(['', 'the answer'], { usdCost: 0.0123 });
    expect(e.credits).toBeUndefined();
    expect(serializeSSEEvent(e)).not.toContain('usdCost');
  });
});

describe('buildSSEEvent', () => {
  it('still forwards usdCost to authenticated first-party surfaces', () => {
    const e = buildSSEEvent(['', 'the answer'], { creditsUsed: 2, usdCost: 0.0123 });
    expect(e.credits).toMatchObject({ used: 2, usdCost: 0.0123 });
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

  it('includes the classifier code when provided', () => {
    expect(formatSSEError(new Error('capped'), 'req-1', 'spend_cap_exceeded')).toEqual({
      type: 'error',
      message: 'capped',
      requestId: 'req-1',
      code: 'spend_cap_exceeded',
    });
  });

  it('omits the code field entirely when no classifier is passed (no undefined serialization)', () => {
    const event = formatSSEError(new Error('boom'), 'req-1');
    expect(event).not.toHaveProperty('code');
    expect(JSON.stringify(event)).not.toContain('code');
  });
});

describe('serializeSSEEvent', () => {
  it('serializes a meta event as an SSE data line', () => {
    expect(serializeSSEEvent(buildMetaEvent('req-123'))).toBe('data: {"type":"meta","requestId":"req-123"}\n\n');
  });
});
