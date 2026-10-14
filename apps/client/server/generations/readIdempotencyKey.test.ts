import { describe, expect, it } from 'vitest';
import { UnprocessableEntityError } from '@bike4mind/common';
import { readIdempotencyKey } from './readIdempotencyKey';

// The published code on the 422 (MusicGenerationApiErrorCode), not just the error class.
const invalidKey = expect.objectContaining({ additionalInfo: { errorCode: 'invalid_idempotency_key' } });

describe('readIdempotencyKey', () => {
  it('returns undefined when the header is absent', () => {
    expect(readIdempotencyKey(undefined)).toBeUndefined();
  });

  it('returns a normal key unchanged', () => {
    expect(readIdempotencyKey('order-123 retry')).toBe('order-123 retry');
  });

  it('rejects a duplicated header (an array) as invalid_idempotency_key', () => {
    expect.assertions(2);
    try {
      readIdempotencyKey(['a', 'b']);
    } catch (error) {
      expect(error).toBeInstanceOf(UnprocessableEntityError);
      expect(error).toMatchObject({ additionalInfo: { errorCode: 'invalid_idempotency_key' } });
    }
  });

  it('accepts 255 characters and rejects 256', () => {
    expect(readIdempotencyKey('k'.repeat(255))).toBe('k'.repeat(255));
    expect(() => readIdempotencyKey('k'.repeat(256))).toThrow(invalidKey);
  });

  it.each(['', 'café', 'line\nbreak'])('rejects the malformed key %j', key => {
    expect(() => readIdempotencyKey(key)).toThrow(invalidKey);
  });
});
