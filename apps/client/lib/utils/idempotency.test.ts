import { describe, expect, it } from 'vitest';
import { generateIdempotencyKey } from './idempotency';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('generateIdempotencyKey', () => {
  it('returns a lowercase RFC 4122 version 4 UUID', () => {
    expect(generateIdempotencyKey()).toMatch(UUID_V4);
  });

  it('does not repeat', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateIdempotencyKey()));
    expect(keys.size).toBe(100);
  });
});
