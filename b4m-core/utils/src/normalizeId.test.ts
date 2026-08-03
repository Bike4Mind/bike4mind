import { describe, expect, it } from 'vitest';
import { normalizeId } from './normalizeId';

describe('normalizeId', () => {
  it('returns a plain string unchanged', () => {
    expect(normalizeId('abc123')).toBe('abc123');
  });

  it('returns undefined for null / undefined / empty string', () => {
    expect(normalizeId(null)).toBeUndefined();
    expect(normalizeId(undefined)).toBeUndefined();
    expect(normalizeId('')).toBeUndefined();
  });

  it('stringifies an ObjectId via toHexString', () => {
    const hex = '507f1f77bcf86cd799439011';
    const objectId = { toHexString: () => hex };
    expect(normalizeId(objectId)).toBe(hex);
  });

  it('extracts the id from a populated document with an ObjectId _id', () => {
    const hex = '507f191e810c19729de860ea';
    const populated = { _id: { toHexString: () => hex }, name: 'Acme' };
    expect(normalizeId(populated)).toBe(hex);
  });

  it('falls back to a virtual string id when no _id is present', () => {
    const populated = { id: '507f191e810c19729de860ea', name: 'Acme' };
    expect(normalizeId(populated)).toBe('507f191e810c19729de860ea');
  });

  it('never yields "[object Object]" for an unrecognized object', () => {
    expect(normalizeId({ foo: 'bar' })).toBeUndefined();
  });

  it('returns undefined for an array (not a valid id shape), not a stringified "1,2,3"', () => {
    expect(normalizeId([1, 2, 3] as unknown)).toBeUndefined();
  });
});
