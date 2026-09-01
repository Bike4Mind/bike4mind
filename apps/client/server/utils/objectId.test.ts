import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { isValidObjectId } from './objectId';

describe('isValidObjectId', () => {
  it('accepts a generated ObjectId string', () => {
    expect(isValidObjectId(new Types.ObjectId().toString())).toBe(true);
  });

  it('accepts an uppercase-hex id, which Mongoose casts to the same ObjectId', () => {
    const lower = new Types.ObjectId().toString();
    const upper = lower.toUpperCase();
    // Guard against a round-trip implementation: `new Types.ObjectId(upper).toString()`
    // lowercases, so comparing it back to `upper` would reject a perfectly valid id.
    expect(new Types.ObjectId(upper).equals(new Types.ObjectId(lower))).toBe(true);
    expect(isValidObjectId(upper)).toBe(true);
  });

  it('rejects anything that is not 24 hex characters', () => {
    expect(isValidObjectId('not-an-object-id')).toBe(false);
    expect(isValidObjectId('')).toBe(false);
    // 24 characters, but `g` is not hex.
    expect(isValidObjectId('g07f1f77bcf86cd79943901g')).toBe(false);
    // Valid hex, wrong length.
    expect(isValidObjectId('507f1f77bcf86cd7994390')).toBe(false);
    expect(isValidObjectId('507f1f77bcf86cd799439011ab')).toBe(false);
  });
});
