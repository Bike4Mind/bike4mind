import { describe, it, expect } from 'vitest';
import { buildMetaEvent, formatSSEError, serializeSSEEvent } from './sseEvents';

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
