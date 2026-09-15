import { describe, it, expect } from 'vitest';
import { stableSubscriptionKey } from './react-query';

describe('stableSubscriptionKey', () => {
  it('produces identical keys for distinct-but-equal query objects', () => {
    // Two separate object instances with the same contents - the exact churn
    // case where a caller passes a fresh inline `{ isChunk: false }` each render.
    const a = stableSubscriptionKey({ isChunk: false });
    const b = stableSubscriptionKey({ isChunk: false });
    expect(a).toBe(b);
  });

  it('is insensitive to key ordering', () => {
    expect(stableSubscriptionKey({ a: 1, b: 2 })).toBe(stableSubscriptionKey({ b: 2, a: 1 }));
  });

  it('serializes nested mongo operators stably', () => {
    expect(stableSubscriptionKey({ age: { $gt: 18 } })).toBe(stableSubscriptionKey({ age: { $gt: 18 } }));
    // nested operator key order must not matter either
    expect(stableSubscriptionKey({ x: { $gt: 1, $lt: 9 } })).toBe(stableSubscriptionKey({ x: { $lt: 9, $gt: 1 } }));
  });

  it('serializes array values ($in) stably and order-sensitively within the array', () => {
    expect(stableSubscriptionKey({ id: { $in: ['a', 'b'] } })).toBe(stableSubscriptionKey({ id: { $in: ['a', 'b'] } }));
    // arrays are ordered data - different order is a different logical query
    expect(stableSubscriptionKey({ id: { $in: ['a', 'b'] } })).not.toBe(
      stableSubscriptionKey({ id: { $in: ['b', 'a'] } })
    );
  });

  it('distinguishes different queries', () => {
    expect(stableSubscriptionKey({ _id: '1' })).not.toBe(stableSubscriptionKey({ _id: '2' }));
    expect(stableSubscriptionKey({ isChunk: false })).not.toBe(stableSubscriptionKey({ isChunk: true }));
  });

  it('serializes Date values by value, not as empty objects', () => {
    // QueryableType permits Date - without special-casing, both collapse to {} and a
    // real query change (different date) would be silently missed.
    const a = stableSubscriptionKey({ createdAt: { $gt: new Date('2020-01-01') } });
    const b = stableSubscriptionKey({ createdAt: { $gt: new Date('2021-01-01') } });
    expect(a).not.toBe(b);
    // identical dates still collapse to one key
    expect(stableSubscriptionKey({ createdAt: { $gt: new Date('2020-01-01') } })).toBe(a);
  });

  it('serializes RegExp values by value, not as empty objects', () => {
    expect(stableSubscriptionKey({ name: { $regex: /foo/i } })).not.toBe(
      stableSubscriptionKey({ name: { $regex: /bar/i } })
    );
  });

  it('gives null and {} distinct, stable keys', () => {
    expect(stableSubscriptionKey(null)).toBe(stableSubscriptionKey(null));
    expect(stableSubscriptionKey({})).toBe(stableSubscriptionKey({}));
    // a null query means "do not subscribe" - it must not collide with an empty match-all query
    expect(stableSubscriptionKey(null)).not.toBe(stableSubscriptionKey({}));
  });
});
