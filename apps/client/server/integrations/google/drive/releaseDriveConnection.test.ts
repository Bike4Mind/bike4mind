import { describe, it, expect, vi, beforeEach } from 'vitest';

// The teardown seam: revoke the org-owned credential at Google, THEN drop the row. Every future
// caller that tears a connection down (lake purge included) must come through here, so the ordering
// and the never-block-on-Google behaviour are what these tests pin.
const h = vi.hoisted(() => ({
  revokeToken: vi.fn(),
  findByIdWithCredentials: vi.fn(),
  release: vi.fn(),
  findByDataLakeIdAny: vi.fn(),
  userFindById: vi.fn(),
  order: [] as string[],
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
    findByDataLakeIdAny: h.findByDataLakeIdAny,
    release: h.release,
    updateHealth: vi.fn(),
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

import { releaseDriveConnection, releaseDriveConnectionForLake } from './common';

describe('releaseDriveConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.order.length = 0;
    h.revokeToken.mockImplementation(async () => {
      h.order.push('revoke');
    });
    h.release.mockImplementation(async () => {
      h.order.push('release');
      return true;
    });
    h.findByIdWithCredentials.mockResolvedValue({
      id: 'conn1',
      connectedBy: 'user-1',
      oauthRefreshToken: 'enc(org-refresh)',
    });
    // Default: the connecting user no longer holds this token, so the connection is its last handle.
    h.userFindById.mockResolvedValue({ googleDrive: null });
  });

  it('revokes the decrypted org credential BEFORE deleting the row', async () => {
    await expect(releaseDriveConnection('conn1', 'orgA')).resolves.toBe(true);
    expect(h.revokeToken).toHaveBeenCalledWith('org-refresh');
    // Delete-first would strand a live grant behind a row nothing can reach any more; revoke-first
    // keeps the credential available for a retry if the revoke is the step that fails.
    expect(h.order).toEqual(['revoke', 'release']);
  });

  it('reads the credential with the org scope it was given', async () => {
    await releaseDriveConnection('conn1', 'orgA');
    expect(h.findByIdWithCredentials).toHaveBeenCalledWith('conn1', 'orgA');
    expect(h.release).toHaveBeenCalledWith('conn1', 'orgA');
  });

  it('still deletes the row when Google refuses the revoke', async () => {
    h.revokeToken.mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 503 } }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(releaseDriveConnection('conn1', 'orgA')).resolves.toBe(true);
    expect(h.release).toHaveBeenCalled();
    // The only signal that the grant may still be live - a smoke test must be able to tell this
    // from "the revoke never ran".
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/revoke failed/), expect.anything());
    consoleError.mockRestore();
  });

  it('treats invalid_token as nothing-left-to-revoke, not a failure', async () => {
    h.revokeToken.mockRejectedValue(
      Object.assign(new Error('bad token'), { response: { status: 400, data: { error: 'invalid_token' } } })
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(releaseDriveConnection('conn1', 'orgA')).resolves.toBe(true);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('does NOT read a malformed request as a successful revoke', async () => {
    // Also a 400, but it means WE sent something bad - reporting it as already-revoked would recreate
    // the silent no-op this whole fix is about.
    h.revokeToken.mockRejectedValue(
      Object.assign(new Error('bad request'), { response: { status: 400, data: { error: 'invalid_request' } } })
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await releaseDriveConnection('conn1', 'orgA');
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/revoke failed/), expect.anything());
    consoleError.mockRestore();
  });

  it('does NOT revoke a credential the connecting user still holds personally', async () => {
    // drive-sync copies the user's refresh token verbatim, so this is the common case. Revoking it
    // would kill THAT user's personal Drive from an org admin's click, with their profile still
    // reading "connected" - well past the org resource being disconnected. Dropping the org copy is
    // the whole teardown here; the grant stays theirs to revoke from their own profile.
    h.userFindById.mockResolvedValue({ googleDrive: { refreshToken: 'enc(org-refresh)' } });
    await expect(releaseDriveConnection('conn1', 'orgA')).resolves.toBe(true);
    expect(h.revokeToken).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledWith('conn1', 'orgA');
  });

  it('revokes when the user holds a DIFFERENT token than the connection', async () => {
    // A re-consent gave the user a new refresh token; the connection's older one is a separate grant
    // that only this row still points at, so releasing the row must take it down.
    h.userFindById.mockResolvedValue({ googleDrive: { refreshToken: 'enc(newer-refresh)' } });
    await releaseDriveConnection('conn1', 'orgA');
    expect(h.revokeToken).toHaveBeenCalledWith('org-refresh');
  });

  it('deletes a credential-less connection without pretending to revoke', async () => {
    h.findByIdWithCredentials.mockResolvedValue({ id: 'conn1', connectedBy: 'user-1', oauthRefreshToken: undefined });
    await expect(releaseDriveConnection('conn1', 'orgA')).resolves.toBe(true);
    expect(h.revokeToken).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledWith('conn1', 'orgA');
  });

  it('is a no-op for a connection that is not visible to the given org', async () => {
    h.findByIdWithCredentials.mockResolvedValue(null);
    await expect(releaseDriveConnection('conn1', 'orgB')).resolves.toBe(false);
    expect(h.revokeToken).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });
});

describe('releaseDriveConnectionForLake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.revokeToken.mockResolvedValue(undefined);
    h.release.mockResolvedValue(true);
    h.userFindById.mockResolvedValue({ googleDrive: null });
    h.findByIdWithCredentials.mockResolvedValue({
      id: 'conn1',
      connectedBy: 'user-1',
      oauthRefreshToken: 'enc(org-refresh)',
    });
  });

  it('releases the connection using the org id stored on the row, not one the caller supplies', async () => {
    // The purge sweep only has a lake id, and by the time it runs the lake document is on its way
    // out - so the org has to come off the connection itself or the release cannot be scoped at all.
    h.findByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA' });
    await expect(releaseDriveConnectionForLake('lake1')).resolves.toBe(true);
    expect(h.findByDataLakeIdAny).toHaveBeenCalledWith('lake1');
    expect(h.release).toHaveBeenCalledWith('conn1', 'orgA');
  });

  it('resolves the row regardless of enabled state, which a disabled row would otherwise strand', async () => {
    // A disabled connection still occupies the unique driveFolderId index, so skipping it here is
    // exactly the strand this path exists to prevent.
    h.findByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA', enabled: false });
    await expect(releaseDriveConnectionForLake('lake1')).resolves.toBe(true);
    expect(h.release).toHaveBeenCalledWith('conn1', 'orgA');
  });

  it('is a no-op for a lake with no Drive connection', async () => {
    h.findByDataLakeIdAny.mockResolvedValue(null);
    await expect(releaseDriveConnectionForLake('lake1')).resolves.toBe(false);
    expect(h.revokeToken).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });
});
