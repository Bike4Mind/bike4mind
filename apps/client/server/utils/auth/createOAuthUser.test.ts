import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isReservedUsername, PENDING_FREE_CREDITS_TAG, usernameSchema, USERNAME_MAX_LENGTH } from '@bike4mind/common';
import { createUniqueOAuthUser, deriveOAuthUsername } from './createOAuthUser';

const mockCreate = vi.fn();
const mockFindSetting = vi.fn();
vi.mock('@bike4mind/database', () => ({
  User: { create: (...args: unknown[]) => mockCreate(...args) },
  adminSettingsRepository: { findBySettingName: (...args: unknown[]) => mockFindSetting(...args) },
}));

const oauthCredentials = { strategy: 'google', id: 'sub-1' };

describe('createUniqueOAuthUser', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockFindSetting.mockReset().mockResolvedValue(null);
    mockCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ _id: 'new-id', ...doc }));
  });

  it('stamps emailVerified when an email is present', async () => {
    await createUniqueOAuthUser({ name: 'Pat', baseUsername: 'pat', email: 'pat@example.com', oauthCredentials });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'pat@example.com', emailVerified: true, emailVerifiedAt: expect.any(Date) })
    );
  });

  it('leaves email and verification unset when there is no email', async () => {
    await createUniqueOAuthUser({ name: 'Pat', baseUsername: 'pat', email: null, oauthCredentials });

    const doc = mockCreate.mock.calls[0][0];
    expect(doc).not.toHaveProperty('email');
    expect(doc).not.toHaveProperty('emailVerified');
    expect(doc).not.toHaveProperty('emailVerifiedAt');
  });

  it('snapshots staging only for a newly created credit-eligible account', async () => {
    mockFindSetting.mockImplementation(async (name: string) => ({
      settingValue: {
        stagedSignupGrantEnabled: 'true',
        signupGrantCredits: '12',
        verifiedUnlockCredits: '28',
      }[name],
    }));
    await createUniqueOAuthUser({
      name: 'Pat',
      baseUsername: 'pat',
      email: 'pat@example.test',
      oauthCredentials,
      pendingFreeCredits: true,
    });
    expect(mockCreate.mock.calls[0][0].signupGrant).toMatchObject({
      stage: 'pending_email',
      signupCredits: 12,
      unlockCredits: 28,
    });
    await createUniqueOAuthUser({ name: 'Pat', baseUsername: 'pat', email: null, oauthCredentials });
    expect(mockCreate.mock.calls[1][0]).not.toHaveProperty('signupGrant');
  });

  it('tags the account pending-free-credits only when asked', async () => {
    await createUniqueOAuthUser({
      name: 'Pat',
      baseUsername: 'pat',
      email: 'pat@example.com',
      oauthCredentials,
      pendingFreeCredits: true,
    });
    await createUniqueOAuthUser({ name: 'Pat', baseUsername: 'pat', email: 'pat@example.com', oauthCredentials });

    expect(mockCreate.mock.calls[0][0]).toEqual(expect.objectContaining({ tags: [PENDING_FREE_CREDITS_TAG] }));
    expect(mockCreate.mock.calls[1][0]).not.toHaveProperty('tags');
  });

  it('retries with a disambiguated username on a username collision and keeps the verified stamp', async () => {
    mockCreate.mockRejectedValueOnce({ code: 11000, keyPattern: { username: 1 } });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await createUniqueOAuthUser({ name: 'Pat', baseUsername: 'pat', email: 'pat@example.com', oauthCredentials });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[1][0]).toEqual(expect.objectContaining({ username: 'pat 2', emailVerified: true }));
  });
});

describe('deriveOAuthUsername', () => {
  it('prefers the provider username, then the name, then the email local part', () => {
    expect(deriveOAuthUsername('handle', 'Pat Doe', 'pat@example.com')).toBe('handle');
    expect(deriveOAuthUsername(null, 'Pat Doe', 'pat@example.com')).toBe('Pat Doe');
    expect(deriveOAuthUsername(null, '', 'pat.doe@example.com')).toBe('pat.doe');
    expect(deriveOAuthUsername('alice@corp.com', '', null)).toBe('alice');
  });

  it('strips characters outside the username rules and collapses whitespace', () => {
    expect(deriveOAuthUsername(null, '  <b>Pat</b>\t  Doe ', null)).toBe('bPatb Doe');
  });

  it('moves to the next source when a candidate has no usable characters', () => {
    expect(deriveOAuthUsername('@@@', '!!!', 'pat+tag@example.com')).toBe('pattag');
  });

  it('falls back to a generated handle when every source is empty after sanitizing', () => {
    expect(deriveOAuthUsername(null, '***', null)).toMatch(/^user-[0-9a-f]{8}$/);
  });

  it('never yields the reserved test-persona prefix, from any source', () => {
    expect(deriveOAuthUsername('persona-bot', 'Pat Doe', null)).toBe('bot');
    expect(deriveOAuthUsername(null, 'Persona-Pat', null)).toBe('Pat');
    expect(deriveOAuthUsername(null, '', 'persona-pat@example.com')).toBe('pat');
    expect(deriveOAuthUsername('persona-', 'PERSONA-', 'persona-@example.com')).toMatch(/^user-[0-9a-f]{8}$/);
    for (const name of ['persona-x', '  persona-y', 'PERSONA-persona-z']) {
      expect(isReservedUsername(deriveOAuthUsername(null, name, null))).toBe(false);
    }
  });

  it('keeps the retry suffixes off a stripped base unreserved', () => {
    const base = deriveOAuthUsername(null, 'persona-pat', null);
    for (const candidate of [base, `${base} 2`, `${base}-abcdef`]) {
      expect(isReservedUsername(candidate)).toBe(false);
    }
  });

  it('leaves room for the longest retry suffix within the length cap', () => {
    const base = deriveOAuthUsername(null, 'a'.repeat(200), null);

    expect(base.length).toBe(USERNAME_MAX_LENGTH - 7);
    for (const candidate of [base, `${base} 2`, `${base} 5`, `${base}-abcdef`]) {
      expect(usernameSchema.safeParse(candidate).success).toBe(true);
    }
  });
});

describe('createUniqueOAuthUser retry suffixes', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  it('only ever tries usernames that satisfy the username rules', async () => {
    const collision = { code: 11000, keyPattern: { username: 1 } };
    mockCreate
      .mockRejectedValueOnce(collision)
      .mockRejectedValueOnce(collision)
      .mockRejectedValueOnce(collision)
      .mockRejectedValueOnce(collision)
      .mockRejectedValueOnce(collision)
      .mockImplementationOnce(async (doc: Record<string, unknown>) => ({ _id: 'new-id', ...doc }));
    const baseUsername = deriveOAuthUsername(null, 'x'.repeat(100), null);

    await createUniqueOAuthUser({ name: 'X', baseUsername, email: null, oauthCredentials });

    const tried = mockCreate.mock.calls.map(call => (call[0] as { username: string }).username);
    expect(tried).toHaveLength(6);
    expect(tried[5]).toMatch(/-[0-9a-f]{6}$/);
    for (const username of tried) {
      expect(usernameSchema.safeParse(username).success).toBe(true);
    }
  });
});
