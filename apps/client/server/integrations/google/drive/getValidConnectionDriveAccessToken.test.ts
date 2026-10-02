import { describe, it, expect, vi, beforeEach } from 'vitest';

// The ingest job's credential: an org connection's own copy, else the connecting user's live grant -
// which is the ONLY credential a personal connection has. Either one failing must flip the connection
// to credential_error, or the hourly poll keeps re-running a sync that can never authenticate.
const h = vi.hoisted(() => ({
  findByIdWithCredentials: vi.fn(),
  updateHealth: vi.fn(),
  userFindById: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

vi.mock('@server/security/tokenEncryption', () => ({
  encryptToken: (v?: string | null) => (v ? `enc(${v})` : null),
  decryptToken: (v?: string | null) => {
    if (!v) return null;
    const m = /^enc\((.*)\)$/.exec(v);
    if (!m) throw new Error('Token decryption failed');
    return m[1];
  },
}));
vi.mock('@bike4mind/database', () => ({
  User: { findById: h.userFindById, updateOne: vi.fn() },
  orgGoogleDriveConnectionRepository: {
    findByIdWithCredentials: h.findByIdWithCredentials,
    updateHealth: h.updateHealth,
  },
}));
vi.mock('@googleapis/drive', () => ({
  auth: {
    OAuth2: class {
      setCredentials = vi.fn();
      refreshAccessToken = h.refreshAccessToken;
      generateAuthUrl = () => 'https://auth';
      getToken = vi.fn();
      revokeToken = vi.fn();
    },
  },
  drive: vi.fn(),
}));

import { getValidConnectionDriveAccessToken } from './common';

const personalOwner = { kind: 'user' as const, userId: 'user-1' };
const orgOwner = { kind: 'organization' as const, organizationId: 'orgA' };
const liveUserGrant = {
  googleDrive: {
    accessToken: 'enc(user-access)',
    refreshToken: 'enc(user-refresh)',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getValidConnectionDriveAccessToken', () => {
  it("resolves a personal connection from its owner's live grant, scoped to that owner", async () => {
    h.findByIdWithCredentials.mockResolvedValue({ id: 'conn1', connectedBy: 'user-1' });
    h.userFindById.mockResolvedValue(liveUserGrant);

    await expect(getValidConnectionDriveAccessToken('conn1', personalOwner)).resolves.toBe('user-access');
    expect(h.findByIdWithCredentials).toHaveBeenCalledWith('conn1', personalOwner);
    expect(h.updateHealth).not.toHaveBeenCalled();
  });

  it('marks a personal connection credential_error once its owner has unlinked Google Drive', async () => {
    h.findByIdWithCredentials.mockResolvedValue({ id: 'conn1', connectedBy: 'user-1' });
    h.userFindById.mockResolvedValue({ googleDrive: null });

    await expect(getValidConnectionDriveAccessToken('conn1', personalOwner)).rejects.toThrow(/not connected/);
    expect(h.updateHealth).toHaveBeenCalledWith('conn1', expect.objectContaining({ status: 'credential_error' }));
  });

  it("marks an org connection credential_error when its own copy fails to refresh, without trying the user's", async () => {
    h.findByIdWithCredentials.mockResolvedValue({
      id: 'conn2',
      connectedBy: 'user-1',
      oauthRefreshToken: 'enc(org-refresh)',
    });
    h.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));

    await expect(getValidConnectionDriveAccessToken('conn2', orgOwner)).rejects.toThrow('invalid_grant');
    expect(h.updateHealth).toHaveBeenCalledWith('conn2', { status: 'credential_error', lastError: 'invalid_grant' });
    expect(h.userFindById).not.toHaveBeenCalled();
  });

  it('marks credential_error on a revoked user grant surfaced as an OAuth invalid_grant body', async () => {
    h.findByIdWithCredentials.mockResolvedValue({ id: 'conn1', connectedBy: 'user-1' });
    h.userFindById.mockResolvedValue({ googleDrive: { ...liveUserGrant.googleDrive, expiresAt: new Date(0) } });
    h.refreshAccessToken.mockRejectedValue(
      Object.assign(new Error('Token has been expired or revoked.'), { response: { data: { error: 'invalid_grant' } } })
    );

    await expect(getValidConnectionDriveAccessToken('conn1', personalOwner)).rejects.toThrow(/revoked/);
    expect(h.updateHealth).toHaveBeenCalledWith('conn1', expect.objectContaining({ status: 'credential_error' }));
  });

  it('marks credential_error when the org copy cannot be decrypted', async () => {
    h.findByIdWithCredentials.mockResolvedValue({ id: 'conn2', connectedBy: 'user-1', oauthRefreshToken: 'garbled' });

    await expect(getValidConnectionDriveAccessToken('conn2', orgOwner)).rejects.toThrow(/reconnect required/);
    expect(h.updateHealth).toHaveBeenCalledWith('conn2', expect.objectContaining({ status: 'credential_error' }));
    expect(h.refreshAccessToken).not.toHaveBeenCalled();
  });

  // credential_error is sticky (the poll skips it and only a reconnect clears it), so a blip must
  // rethrow unmarked and leave the ingest handler to release the claim for the next poll.
  it.each([
    ['a Google 5xx on the user grant refresh', 'personal'],
    ['a Google 5xx on the org copy refresh', 'org'],
  ])('leaves health untouched on %s', async (_label, kind) => {
    h.findByIdWithCredentials.mockResolvedValue(
      kind === 'org'
        ? { id: 'conn2', connectedBy: 'user-1', oauthRefreshToken: 'enc(org-refresh)' }
        : { id: 'conn1', connectedBy: 'user-1' }
    );
    h.userFindById.mockResolvedValue({ googleDrive: { ...liveUserGrant.googleDrive, expiresAt: new Date(0) } });
    h.refreshAccessToken.mockRejectedValue(
      Object.assign(new Error('Backend Error'), { response: { status: 503, data: { error: 'backendError' } } })
    );

    await expect(
      getValidConnectionDriveAccessToken(kind === 'org' ? 'conn2' : 'conn1', kind === 'org' ? orgOwner : personalOwner)
    ).rejects.toThrow('Backend Error');
    expect(h.updateHealth).not.toHaveBeenCalled();
  });

  it('leaves health untouched when the user lookup itself fails', async () => {
    h.findByIdWithCredentials.mockResolvedValue({ id: 'conn1', connectedBy: 'user-1' });
    h.userFindById.mockRejectedValue(new Error('MongoNetworkError: connection reset'));

    await expect(getValidConnectionDriveAccessToken('conn1', personalOwner)).rejects.toThrow(/MongoNetworkError/);
    expect(h.updateHealth).not.toHaveBeenCalled();
  });

  it('throws without touching health when the connection is not visible to the owner', async () => {
    h.findByIdWithCredentials.mockResolvedValue(null);

    await expect(getValidConnectionDriveAccessToken('conn3', personalOwner)).rejects.toThrow(/not found/);
    expect(h.updateHealth).not.toHaveBeenCalled();
  });
});
