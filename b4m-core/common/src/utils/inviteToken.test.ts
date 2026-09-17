import { describe, it, expect } from 'vitest';
import { generateInviteToken, isObjectIdShaped } from './inviteToken';

describe('generateInviteToken', () => {
  it('is URL-safe, so it survives a path segment unescaped', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateInviteToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  // 32 bytes base64url, unpadded. Pinned because the entropy IS the security property here: this
  // value replaced a partially-random ObjectId precisely so a link could not be guessed.
  it('carries 256 bits of entropy', () => {
    expect(generateInviteToken()).toHaveLength(43);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateInviteToken));
    expect(tokens.size).toBe(1000);
  });

  // The two key spaces must not overlap, or resolveRedeemableInvite's shape guard could route a
  // token at the legacy id door.
  it('is never mistaken for an ObjectId', () => {
    for (let i = 0; i < 100; i++) {
      expect(isObjectIdShaped(generateInviteToken())).toBe(false);
    }
  });
});

describe('isObjectIdShaped', () => {
  it('accepts a 24-character hex id in either case', () => {
    expect(isObjectIdShaped('65a1f77bcf86cd7994390001')).toBe(true);
    expect(isObjectIdShaped('65A1F77BCF86CD7994390001')).toBe(true);
  });

  it('rejects anything else, so a malformed key misses instead of throwing a CastError', () => {
    expect(isObjectIdShaped('')).toBe(false);
    expect(isObjectIdShaped('invite-1')).toBe(false);
    expect(isObjectIdShaped('65a1f77bcf86cd799439000')).toBe(false);
    expect(isObjectIdShaped('65a1f77bcf86cd79943900012')).toBe(false);
    expect(isObjectIdShaped('65a1f77bcf86cd799439000g')).toBe(false);
    expect(isObjectIdShaped('../../../etc/passwd')).toBe(false);
  });
});
