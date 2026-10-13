import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { createUniqueOAuthUser } from './createOAuthUser';

const mockCreate = vi.fn();
vi.mock('@bike4mind/database', () => ({
  User: { create: (...args: unknown[]) => mockCreate(...args) },
}));

const oauthCredentials = { strategy: 'google', id: 'sub-1' };

describe('createUniqueOAuthUser', () => {
  beforeEach(() => {
    mockCreate.mockReset();
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
