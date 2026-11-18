import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { toPlatformEndUserProviderId, toProviderEndUserId } from './endUserId';

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

describe('toPlatformEndUserProviderId', () => {
  const owner = '507f1f77bcf86cd799439011';

  it('is a stable 64-char hex digest', () => {
    const id = toPlatformEndUserProviderId(owner, 'customer_42');
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(toPlatformEndUserProviderId(owner, 'customer_42')).toBe(id);
  });

  it("differs from the key owner's own identifier and from the plain hash of owner:end_user_id", () => {
    const id = toPlatformEndUserProviderId(owner, 'customer_42');
    expect(id).not.toBe(toProviderEndUserId(owner));
    expect(id).not.toBe(toProviderEndUserId(`${owner}:customer_42`));
  });

  it('separates end users of one platform and the same end_user_id across platforms', () => {
    const other = '507f1f77bcf86cd799439012';
    expect(toPlatformEndUserProviderId(owner, 'a')).not.toBe(toPlatformEndUserProviderId(owner, 'b'));
    expect(toPlatformEndUserProviderId(owner, 'a')).not.toBe(toPlatformEndUserProviderId(other, 'a'));
  });

  it('cannot be shifted across the owner/end-user boundary', () => {
    expect(toPlatformEndUserProviderId('ab', 'c')).not.toBe(toPlatformEndUserProviderId('a', 'bc'));
  });
});
