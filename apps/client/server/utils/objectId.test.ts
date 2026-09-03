import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { isValidObjectId, toObjectIdString } from './objectId';

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

  // The `id: string` parameter is a compile-time claim only, so these pin the runtime
  // contract: a regex would stringify and accept the single-element array, and
  // `Types.ObjectId.isValid` would accept the number and the Buffer and cast each to a
  // fabricated id matching no stored row.
  it('rejects non-string values a caller could smuggle past the type', () => {
    const notStrings: unknown[] = [12, Buffer.alloc(12), ['507f1f77bcf86cd799439011'], null, undefined, {}];
    for (const value of notStrings) {
      expect(isValidObjectId(value as string)).toBe(false);
    }
  });
});

describe('toObjectIdString', () => {
  it('canonicalizes an uppercase-hex id to the lowercase form Mongoose stores', () => {
    const lower = new Types.ObjectId().toString();
    expect(toObjectIdString(lower.toUpperCase())).toBe(lower);
  });

  it('returns a lowercase id unchanged', () => {
    const lower = new Types.ObjectId().toString();
    expect(toObjectIdString(lower)).toBe(lower);
  });

  it('returns undefined for anything that is not an object id', () => {
    expect(toObjectIdString('not-an-object-id')).toBeUndefined();
    expect(toObjectIdString('')).toBeUndefined();
    expect(toObjectIdString('g07f1f77bcf86cd79943901g')).toBeUndefined();
    expect(toObjectIdString(12 as unknown as string)).toBeUndefined();
  });
});
