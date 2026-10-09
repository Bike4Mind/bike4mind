import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockVerifyClientSecret = vi.hoisted(() => vi.fn());
const mockFindByClientId = vi.hoisted(() => vi.fn());
const mockFindGrant = vi.hoisted(() => vi.fn());
const mockUserFindById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/auth', () => ({
  oauthClientRepository: { verifyClientSecret: mockVerifyClientSecret, findByClientId: mockFindByClientId },
  oauthGrantRepository: { findGrant: mockFindGrant },
  userRepository: { findById: mockUserFindById },
}));

const mockAssertAccountStateUsable = vi.hoisted(() => vi.fn());
vi.mock('@server/cli/auth', () => ({ assertAccountStateUsable: mockAssertAccountStateUsable }));

const mockVerifyIdToken = vi.hoisted(() => vi.fn());
vi.mock('@server/auth/verifyFederatedIdToken', () => ({
  verifyFederatedIdToken: mockVerifyIdToken,
  FederatedIdTokenError: class FederatedIdTokenError extends Error {},
}));

import {
  resolveIdentifiedEmbedUser,
  loadIdentifiedEmbedUser,
  reauthorizeIdentifiedSession,
} from './identifiedEmbedUser';
import { FederatedIdTokenError } from '@server/auth/verifyFederatedIdToken';

const CLIENT = {
  clientType: 'relying-party',
  federatedIdp: { issuer: 'https://host.example.com', audience: 'aud', subjectSource: 'sub' },
  allowedScopes: ['openid', 'ai:generate'],
};
const USER = { id: 'host-user-1', aupAcceptedVersion: '2025-01-01' };
const MINT = { client_id: 'client-1', client_secret: 'secret', id_token: 'id-token' };

const ALLOWED = ['client-1'];
const logger = { warn: vi.fn() };

beforeEach(() => {
  mockVerifyClientSecret.mockResolvedValue(CLIENT);
  mockFindByClientId.mockResolvedValue(CLIENT);
  mockVerifyIdToken.mockResolvedValue({ b4mUserId: USER.id, claims: {} });
  mockFindGrant.mockResolvedValue({ scopes: ['openid', 'ai:generate'] });
  mockUserFindById.mockResolvedValue(USER);
  mockAssertAccountStateUsable.mockReturnValue(undefined);
});

afterEach(() => vi.clearAllMocks());

describe('resolveIdentifiedEmbedUser', () => {
  it("resolves the host's authenticated user from a verified federated ID token", async () => {
    expect(await resolveIdentifiedEmbedUser(MINT, ALLOWED, logger)).toEqual({ userId: USER.id });
    expect(mockVerifyClientSecret).toHaveBeenCalledWith('client-1', 'secret');
    expect(mockVerifyIdToken).toHaveBeenCalledWith('id-token', CLIENT.federatedIdp);
  });

  it('rejects a client the embed key never opted into, before checking its secret', async () => {
    expect(await resolveIdentifiedEmbedUser(MINT, ['other-client'], logger)).toEqual({
      rejection: expect.objectContaining({ status: 403, error: 'access_denied' }),
    });
    expect(await resolveIdentifiedEmbedUser(MINT, undefined, logger)).toEqual({
      rejection: expect.objectContaining({ status: 403 }),
    });
    expect(mockVerifyClientSecret).not.toHaveBeenCalled();
  });

  it('rejects an unknown client or bad secret', async () => {
    mockVerifyClientSecret.mockResolvedValue(null);
    expect(await resolveIdentifiedEmbedUser(MINT, ALLOWED, logger)).toEqual({
      rejection: expect.objectContaining({ status: 401, error: 'invalid_client' }),
    });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it('rejects a client with no federated trust config', async () => {
    mockVerifyClientSecret.mockResolvedValue({ ...CLIENT, federatedIdp: undefined });
    expect(await resolveIdentifiedEmbedUser(MINT, ALLOWED, logger)).toEqual({
      rejection: expect.objectContaining({ status: 403, error: 'access_denied' }),
    });
  });

  it('rejects a client not registered for ai:generate, since the user pays', async () => {
    mockVerifyClientSecret.mockResolvedValue({ ...CLIENT, allowedScopes: ['openid'] });
    expect(await resolveIdentifiedEmbedUser(MINT, ALLOWED, logger)).toEqual({
      rejection: expect.objectContaining({ status: 403, error: 'invalid_scope' }),
    });
  });

  it('rejects an ID token that fails verification', async () => {
    mockVerifyIdToken.mockRejectedValue(new FederatedIdTokenError('bad signature'));
    expect(await resolveIdentifiedEmbedUser(MINT, ALLOWED, logger)).toEqual({
      rejection: { status: 401, error: 'invalid_grant', error_description: 'Invalid ID token' },
    });
  });

  it('enforces the grant gate even when the platform-wide lever is in grace mode', async () => {
    mockFindGrant.mockResolvedValue({ scopes: ['openid'] });
    expect(await resolveIdentifiedEmbedUser(MINT, ALLOWED, logger)).toEqual({
      rejection: expect.objectContaining({ status: 403, error: 'access_denied' }),
    });
    mockFindGrant.mockResolvedValue(null);
    expect(await resolveIdentifiedEmbedUser(MINT, ALLOWED, logger)).toEqual({
      rejection: expect.objectContaining({ status: 403, error: 'access_denied' }),
    });
  });

  it('rejects a subject that resolves to no B4M user', async () => {
    mockUserFindById.mockResolvedValue(null);
    expect(await resolveIdentifiedEmbedUser(MINT, ALLOWED, logger)).toEqual({
      rejection: expect.objectContaining({ status: 401, error: 'invalid_grant' }),
    });
  });

  it("requires the identified user's own policy acceptance", async () => {
    mockUserFindById.mockResolvedValue({ id: USER.id });
    expect(await resolveIdentifiedEmbedUser(MINT, ALLOWED, logger)).toEqual({
      rejection: { status: 403, error: 'access_denied', error_description: 'Policy acceptance required' },
    });
  });
});

describe('loadIdentifiedEmbedUser', () => {
  it('returns the user when the account is usable and consented', async () => {
    expect(await loadIdentifiedEmbedUser(USER.id)).toEqual({ user: USER });
  });

  it('rejects a banned or otherwise unusable account', async () => {
    mockAssertAccountStateUsable.mockImplementation(() => {
      throw new Error('Account suspended');
    });
    expect(await loadIdentifiedEmbedUser(USER.id)).toEqual({
      rejection: { status: 403, error: 'access_denied', error_description: 'Account suspended' },
    });
  });
});

describe('reauthorizeIdentifiedSession', () => {
  const args = { userId: USER.id, clientId: 'client-1', allowedClientIds: ALLOWED, logger };

  it('passes while the key, client, grant and user all still authorize the session', async () => {
    expect(await reauthorizeIdentifiedSession(args)).toEqual({ user: USER });
  });

  it('fails once the key owner drops the client', async () => {
    expect(await reauthorizeIdentifiedSession({ ...args, allowedClientIds: [] })).toEqual({
      rejection: expect.objectContaining({ status: 403 }),
    });
  });

  it('fails once the client is deactivated', async () => {
    mockFindByClientId.mockResolvedValue(null);
    expect(await reauthorizeIdentifiedSession(args)).toEqual({
      rejection: expect.objectContaining({ status: 401, error: 'invalid_client' }),
    });
  });

  it('fails once the user revokes the grant', async () => {
    mockFindGrant.mockResolvedValue(null);
    expect(await reauthorizeIdentifiedSession(args)).toEqual({
      rejection: expect.objectContaining({ status: 403, error: 'access_denied' }),
    });
  });
});
