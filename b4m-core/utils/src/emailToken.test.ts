import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { emailTokenMatches, emailTokenStoredValues, hashEmailToken } from './emailToken';

const UUID = '3f2b8c1e-6a4d-4e2f-9b7a-1c5d8e9f0a2b';

describe('hashEmailToken', () => {
  it('is the SHA-256 hex digest of the token', () => {
    expect(hashEmailToken(UUID)).toBe(createHash('sha256').update(UUID).digest('hex'));
    expect(hashEmailToken(UUID)).not.toContain(UUID);
  });
});

describe('emailTokenStoredValues', () => {
  it('includes the plaintext only for a UUID-shaped token', () => {
    expect(emailTokenStoredValues(UUID)).toEqual([hashEmailToken(UUID), UUID]);
    expect(emailTokenStoredValues('not-a-uuid')).toEqual([hashEmailToken('not-a-uuid')]);
  });

  it('never offers a stored digest as its own match', () => {
    const digest = hashEmailToken(UUID);
    expect(emailTokenStoredValues(digest)).not.toContain(digest);
  });

  it('returns nothing for an empty token', () => {
    expect(emailTokenStoredValues('')).toEqual([]);
  });
});

describe('emailTokenMatches', () => {
  it('matches a raw token against its stored hash', () => {
    expect(emailTokenMatches(UUID, hashEmailToken(UUID))).toBe(true);
  });

  it('matches a legacy plaintext UUID stored as-is', () => {
    expect(emailTokenMatches(UUID, UUID)).toBe(true);
  });

  it('rejects the stored hash presented as the token', () => {
    const digest = hashEmailToken(UUID);
    expect(emailTokenMatches(digest, digest)).toBe(false);
  });

  it('rejects a different token, an empty token and an empty stored value', () => {
    expect(emailTokenMatches('8a1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e', hashEmailToken(UUID))).toBe(false);
    expect(emailTokenMatches('', hashEmailToken(''))).toBe(false);
    expect(emailTokenMatches(UUID, null)).toBe(false);
    expect(emailTokenMatches(UUID, '')).toBe(false);
  });
});
