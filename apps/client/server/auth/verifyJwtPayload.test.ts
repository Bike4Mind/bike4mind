import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * verifyJwtPayload is the passport-jwt verify callback backing every authenticated
 * request. It must reject a stale tokenVersion (the revocation kill switch) and, when the
 * token carries impersonatedBy, propagate it onto req.user so logout.ts's impersonation
 * guard can see it - see auth.ts:73 and the reopened impersonation-refresh review finding.
 */

const mockFindById = vi.hoisted(() => vi.fn());

vi.mock('@bike4mind/database', () => ({ User: { findById: mockFindById } }));
vi.mock('@bike4mind/services', () => ({
  isTokenVersionCurrent: (payloadVersion?: number, userVersion?: number) =>
    (payloadVersion ?? 0) === (userVersion ?? 0),
  isTokenTypeAcceptable: (tokenType: unknown, expected: string) => tokenType === undefined || tokenType === expected,
}));

import { verifyJwtPayload } from './verifyJwtPayload';

describe('verifyJwtPayload', () => {
  beforeEach(() => {
    mockFindById.mockReset();
  });

  it('propagates impersonatedBy onto the authenticated user', async () => {
    mockFindById.mockResolvedValue({ id: 'customer-1', tokenVersion: 0, isSystem: false });
    const done = vi.fn();

    await verifyJwtPayload({ id: 'customer-1', tokenVersion: 0, impersonatedBy: 'admin-9' }, done);

    expect(done).toHaveBeenCalledWith(null, expect.objectContaining({ impersonatedBy: 'admin-9' }));
  });

  it('leaves impersonatedBy undefined for a non-impersonated token', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', tokenVersion: 0, isSystem: false });
    const done = vi.fn();

    await verifyJwtPayload({ id: 'user-1', tokenVersion: 0 }, done);

    const [, user] = done.mock.calls[0];
    expect((user as { impersonatedBy?: string }).impersonatedBy).toBeUndefined();
  });

  it('rejects a token minted for a different path (e.g. a refresh token replayed here)', async () => {
    const done = vi.fn();

    await verifyJwtPayload({ id: 'user-1', tokenVersion: 0, typ: 'refresh' }, done);

    expect(done).toHaveBeenCalledWith(null, false);
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('accepts a legacy pre-claim token with no typ', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', tokenVersion: 0, isSystem: false });
    const done = vi.fn();

    await verifyJwtPayload({ id: 'user-1', tokenVersion: 0 }, done);

    expect(done).toHaveBeenCalledWith(null, expect.objectContaining({ id: 'user-1' }));
  });

  it('rejects a stale tokenVersion (the revocation kill switch)', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', tokenVersion: 2, isSystem: false });
    const done = vi.fn();

    await verifyJwtPayload({ id: 'user-1', tokenVersion: 1 }, done);

    expect(done).toHaveBeenCalledWith(null, false);
  });

  it('rejects a system user', async () => {
    mockFindById.mockResolvedValue({ id: 'system-1', tokenVersion: 0, isSystem: true });
    const done = vi.fn();

    await verifyJwtPayload({ id: 'system-1', tokenVersion: 0 }, done);

    expect(done).toHaveBeenCalledWith(null, false);
  });

  it('rejects when the user no longer exists', async () => {
    mockFindById.mockResolvedValue(null);
    const done = vi.fn();

    await verifyJwtPayload({ id: 'ghost-1', tokenVersion: 0 }, done);

    expect(done).toHaveBeenCalledWith(null, false);
  });

  it('treats a DB error as an auth failure instead of throwing', async () => {
    mockFindById.mockRejectedValue(new Error('ECONNRESET'));
    const done = vi.fn();

    await verifyJwtPayload({ id: 'user-1', tokenVersion: 0 }, done);

    expect(done).toHaveBeenCalledWith(null, false);
  });

  it('stamps oauthGrant onto the user for a kind:oauth token (the marker oauthRouteGate keys default-deny on)', async () => {
    // Wiring guard: dropping this stamping makes the route gate a no-op (grant undefined -> next()),
    // silently opening every JWT-authed route to a relying-party OAuth token. The gate can only
    // default-deny what verifyJwtPayload marks.
    mockFindById.mockResolvedValue({ id: 'user-1', tokenVersion: 0, isSystem: false });
    const done = vi.fn();

    await verifyJwtPayload(
      { id: 'user-1', tokenVersion: 0, kind: 'oauth', client_id: 'rp-1', scope: 'openid profile', aud: 'https://api' },
      done
    );

    const [, user] = done.mock.calls[0];
    expect((user as { oauthGrant?: unknown }).oauthGrant).toEqual({
      clientId: 'rp-1',
      scopes: ['openid', 'profile'],
      aud: 'https://api',
    });
  });

  it('leaves oauthGrant unset for a first-party session (no kind), so the gate is a no-op for it', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', tokenVersion: 0, isSystem: false });
    const done = vi.fn();

    await verifyJwtPayload({ id: 'user-1', tokenVersion: 0 }, done);

    const [, user] = done.mock.calls[0];
    expect((user as { oauthGrant?: unknown }).oauthGrant).toBeUndefined();
  });
});
