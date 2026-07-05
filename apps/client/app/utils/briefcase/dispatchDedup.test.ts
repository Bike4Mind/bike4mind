import { describe, it, expect, beforeEach } from 'vitest';
import { isFreshNonce, __resetDispatchDedup } from './dispatchDedup';

beforeEach(() => __resetDispatchDedup());

describe('isFreshNonce — single-flight de-duplication', () => {
  it('treats a nonce as fresh the first time, duplicate after', () => {
    expect(isFreshNonce('a')).toBe(true);
    expect(isFreshNonce('a')).toBe(false);
  });

  it('treats distinct nonces independently', () => {
    expect(isFreshNonce('a')).toBe(true);
    expect(isFreshNonce('b')).toBe(true);
  });

  it('allows a nonce again after the TTL elapses', () => {
    expect(isFreshNonce('a', 0)).toBe(true);
    expect(isFreshNonce('a', 30_000)).toBe(false); // within TTL
    expect(isFreshNonce('a', 120_000)).toBe(true); // past TTL → evicted, fresh again
  });

  it('stays bounded — an old nonce is evicted once the cap is exceeded', () => {
    expect(isFreshNonce('keep', 1)).toBe(true);
    for (let i = 0; i < 200; i++) isFreshNonce(`n${i}`, 2);
    // 'keep' was pushed out of the bounded set, so it reads as fresh again.
    expect(isFreshNonce('keep', 3)).toBe(true);
  });
});
