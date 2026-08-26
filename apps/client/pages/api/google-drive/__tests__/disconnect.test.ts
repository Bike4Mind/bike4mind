import { describe, it, expect, vi, beforeEach } from 'vitest';

// The load-bearing behaviour here is WHICH stored value reaches Google's revoke endpoint, and that it
// is reached at all: the bug this covers passed ciphertext and only fired for an unexpired token, so
// revocation never actually happened. Mocks stop at the oauth2 client so the decrypt runs for real.
const h = vi.hoisted(() => ({
  revokeToken: vi.fn(),
  userFindById: vi.fn(),
  userFindByIdAndUpdate: vi.fn(),
  findByConnectedBy: vi.fn(),
  findByIdWithCredentials: vi.fn(),
  updateHealth: vi.fn(),
  encryptToken: vi.fn((v?: string | null) => (v ? `enc(${v})` : null)),
  decryptToken: vi.fn((v?: string | null) => {
    if (!v) return null;
    const m = /^enc\((.*)\)$/.exec(v);
    if (!m) throw new Error('Token decryption failed');
    return m[1];
  }),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@server/security/tokenEncryption', () => ({
  encryptToken: h.encryptToken,
  decryptToken: h.decryptToken,
}));
vi.mock('@bike4mind/database', () => ({
  User: { findById: h.userFindById, findByIdAndUpdate: h.userFindByIdAndUpdate },
  orgGoogleDriveConnectionRepository: {
    findByConnectedBy: h.findByConnectedBy,
    findByIdWithCredentials: h.findByIdWithCredentials,
    release: vi.fn(),
    updateHealth: h.updateHealth,
  },
}));
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        revokeToken = h.revokeToken;
        generateAuthUrl = () => 'https://auth';
        getToken = vi.fn();
        setCredentials = vi.fn();
        refreshAccessToken = vi.fn();
      },
    },
  },
}));

import handler from '../disconnect';

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json, send: vi.fn() }));
  return { res: { json, status } as never, json, status };
};
const run = (res: unknown) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)({ method: 'DELETE', user: { id: 'u1' } }, res);

/** Stored credential shape, always ciphertext - that is the whole point of the bug. */
const stored = (over: Partial<{ accessToken: string; refreshToken: string; expiresAt: Date }> = {}) => ({
  googleDrive: {
    accessToken: 'enc(access-abc)',
    refreshToken: 'enc(refresh-xyz)',
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  },
});

describe('DELETE /api/google-drive/disconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.userFindById.mockResolvedValue(stored());
    h.userFindByIdAndUpdate.mockResolvedValue({});
    h.findByConnectedBy.mockResolvedValue([]);
    // By default every org connection holds the same copied credential the revoke just killed.
    h.findByIdWithCredentials.mockImplementation(async (id: string) => ({
      id,
      oauthRefreshToken: 'enc(refresh-xyz)',
    }));
    h.revokeToken.mockResolvedValue(undefined);
  });

  it('revokes the DECRYPTED refresh token, not the stored ciphertext', async () => {
    const { res } = makeRes();
    await run(res);
    // The refresh token: revoking it kills the grant, which cascades to every access token. Passing
    // ciphertext (the original bug) made Google reject an unparseable token and revoke nothing.
    expect(h.revokeToken).toHaveBeenCalledWith('refresh-xyz');
    expect(h.userFindByIdAndUpdate).toHaveBeenCalledWith('u1', { googleDrive: null });
  });

  it('revokes even when the access token has already expired', async () => {
    h.userFindById.mockResolvedValue(stored({ expiresAt: new Date(Date.now() - 60_000) }));
    const { res } = makeRes();
    await run(res);
    // An expired ACCESS token says nothing about the grant, which outlives it. The old
    // `!isAccessTokenExpired` gate meant a stale connection was never revoked at all.
    expect(h.revokeToken).toHaveBeenCalledWith('refresh-xyz');
  });

  it('falls back to the access token only when no refresh token was stored', async () => {
    h.userFindById.mockResolvedValue(stored({ refreshToken: undefined as unknown as string }));
    const { res } = makeRes();
    await run(res);
    expect(h.revokeToken).toHaveBeenCalledWith('access-abc');
  });

  it('still completes the local disconnect when Google refuses the revoke', async () => {
    h.revokeToken.mockRejectedValue(new Error('network down'));
    const { res, status } = makeRes();
    await run(res);
    // Refusing to disconnect on a provider outage would leave BOTH a live grant AND our stored copy.
    expect(h.userFindByIdAndUpdate).toHaveBeenCalledWith('u1', { googleDrive: null });
    expect(status).toHaveBeenCalledWith(200);
  });

  it('flags org connections that borrowed this credential and reports the count', async () => {
    h.findByConnectedBy.mockResolvedValue([
      { id: 'conn1', organizationId: 'orgA' },
      { id: 'conn2', organizationId: 'orgB' },
    ]);
    const { res, json } = makeRes();
    await run(res);
    expect(h.findByConnectedBy).toHaveBeenCalledWith('u1');
    // The revoke cascades to the org connections' copied credential, so they must not keep reading
    // healthy while their next ingest silently fails.
    expect(h.updateHealth).toHaveBeenCalledWith('conn1', expect.objectContaining({ status: 'credential_error' }));
    expect(h.updateHealth).toHaveBeenCalledWith('conn2', expect.objectContaining({ status: 'credential_error' }));
    expect(json).toHaveBeenCalledWith({ affectedOrgConnections: 2 });
  });

  it('leaves a connection holding a DIFFERENT token of the same user alone', async () => {
    // An older refresh token is a separate grant at Google and survives this revoke. Flagging it
    // credential_error would stop a sync that still works (findDueForPoll skips that status).
    h.findByConnectedBy.mockResolvedValue([{ id: 'conn1', organizationId: 'orgA' }]);
    h.findByIdWithCredentials.mockResolvedValue({ id: 'conn1', oauthRefreshToken: 'enc(refresh-older)' });
    const { res, json } = makeRes();
    await run(res);
    expect(h.updateHealth).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ affectedOrgConnections: 0 });
  });

  it('flags nothing when only an access token was stored to revoke', async () => {
    // Revoking a lone access token kills that token and nothing downstream, so no org connection is
    // affected - and captureOrgCredential cannot have made one without a refresh token anyway.
    h.userFindById.mockResolvedValue(stored({ refreshToken: undefined as unknown as string }));
    h.findByConnectedBy.mockResolvedValue([{ id: 'conn1', organizationId: 'orgA' }]);
    const { res, json } = makeRes();
    await run(res);
    expect(h.findByConnectedBy).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ affectedOrgConnections: 0 });
  });

  it('reports zero affected connections when none borrowed the credential', async () => {
    const { res, json } = makeRes();
    await run(res);
    expect(h.updateHealth).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ affectedOrgConnections: 0 });
  });

  it('rejects a user with no Google Drive connection', async () => {
    h.userFindById.mockResolvedValue({ googleDrive: null });
    const { res } = makeRes();
    await expect(run(res)).rejects.toThrow(/do not have Google Drive connected/i);
    expect(h.revokeToken).not.toHaveBeenCalled();
  });

  it('does not swallow an undecryptable credential into a silent success', async () => {
    // Post key-rotation ciphertext: nothing can be revoked, so the local record still goes (the user
    // asked to disconnect) but the failure must be logged, never reported as a revoke.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.userFindById.mockResolvedValue(stored({ refreshToken: 'garbage-not-our-ciphertext' }));
    const { res } = makeRes();
    await run(res);
    expect(h.revokeToken).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/revoke failed/), expect.anything());
    expect(h.userFindByIdAndUpdate).toHaveBeenCalledWith('u1', { googleDrive: null });
    consoleError.mockRestore();
  });
});
