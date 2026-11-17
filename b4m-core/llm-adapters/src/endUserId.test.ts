import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { platformEndUserKey, toProviderEndUserId } from './endUserId';

describe('toProviderEndUserId', () => {
  it('returns undefined for empty/absent input so the field can be omitted', () => {
    expect(toProviderEndUserId(undefined)).toBeUndefined();
    expect(toProviderEndUserId(null)).toBeUndefined();
    expect(toProviderEndUserId('')).toBeUndefined();
    expect(toProviderEndUserId('   ')).toBeUndefined();
  });

  it('produces a 64-char hex digest within both providers 64-char limit', () => {
    const id = toProviderEndUserId('507f1f77bcf86cd799439011');
    expect(id).toBeDefined();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id!.length).toBe(64);
  });

  it('is deterministic so a given user maps to the same identifier across requests', () => {
    expect(toProviderEndUserId('user-123')).toBe(toProviderEndUserId('user-123'));
  });

  it('maps different users to different identifiers', () => {
    expect(toProviderEndUserId('user-123')).not.toBe(toProviderEndUserId('user-456'));
  });

  it('does not leak PII: output is a hash, never the raw input', () => {
    const email = 'jane.doe@example.com';
    const hashed = toProviderEndUserId(email);
    expect(hashed).not.toContain('jane');
    expect(hashed).not.toContain('@');
    expect(hashed).not.toBe(email);
    // Matches a plain SHA-256 of the trimmed input.
    expect(hashed).toBe(createHash('sha256').update(email).digest('hex'));
  });

  it('trims surrounding whitespace before hashing so equivalent ids collapse', () => {
    expect(toProviderEndUserId('  user-123  ')).toBe(toProviderEndUserId('user-123'));
  });
});

describe('platformEndUserKey', () => {
  it('prefixes the end-user id with the key owner id', () => {
    expect(platformEndUserKey('507f1f77bcf86cd799439011', 'player-42')).toBe('507f1f77bcf86cd799439011:player-42');
  });

  it('keeps the same end-user id of two owners apart, and apart from the owner itself', () => {
    const a = toProviderEndUserId(platformEndUserKey('owner-a', 'player-42'));
    const b = toProviderEndUserId(platformEndUserKey('owner-b', 'player-42'));
    expect(a).not.toBe(b);
    expect(a).not.toBe(toProviderEndUserId('owner-a'));
  });
});
