import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import { createStateToken } from '@server/auth/jwtStateStore';
import { NONCE_SLOT } from '@server/auth/oauthFlowCookie';

const h = vi.hoisted(() => ({
  exchangeInstallerCode: vi.fn(),
  listInstallerVisibleRepositories: vi.fn(),
  revokeInstallerToken: vi.fn(),
  getInstallation: vi.fn(),
  deleteInstallation: vi.fn(),
  getGitHubLakeAppConfig: vi.fn(),
  verifyOrgAccess: vi.fn(),
  dlFindById: vi.fn(),
  ghConnFindByDataLakeIdAny: vi.fn(),
  ghConnFindByInstallationId: vi.fn(),
  ghConnCreate: vi.fn(),
  ghConnRelease: vi.fn(),
  driveConnFindByDataLakeIdAny: vi.fn(),
}));

vi.mock('./lakeAppClient', () => ({
  exchangeInstallerCode: h.exchangeInstallerCode,
  listInstallerVisibleRepositories: h.listInstallerVisibleRepositories,
  revokeInstallerToken: h.revokeInstallerToken,
  getInstallation: h.getInstallation,
  deleteInstallation: h.deleteInstallation,
  getGitHubLakeAppConfig: h.getGitHubLakeAppConfig,
}));
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess: h.verifyOrgAccess }));
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    dataLakeRepository: { ...actual.dataLakeRepository, findById: h.dlFindById },
    orgGitHubLakeConnectionRepository: {
      ...actual.orgGitHubLakeConnectionRepository,
      findByDataLakeIdAny: h.ghConnFindByDataLakeIdAny,
      findByInstallationId: h.ghConnFindByInstallationId,
      create: h.ghConnCreate,
      release: h.ghConnRelease,
    },
    orgGoogleDriveConnectionRepository: {
      ...actual.orgGoogleDriveConnectionRepository,
      findByDataLakeIdAny: h.driveConnFindByDataLakeIdAny,
    },
  };
});

import {
  resolveConnectableLake,
  completeGitHubLakeConnection,
  verifyGitHubLakeState,
  buildGitHubLakeConnectUrls,
  releaseGitHubLakeConnection,
  releaseGitHubLakeConnectionForLake,
  GITHUB_LAKE_STATE_OPTIONS,
} from './githubLakeConnection';
import type { GitHubLakeAppConfig, GitHubLakeInstallation, GitHubLakeRepository } from './lakeAppClient';
import type { IOrgGitHubLakeConnectionDocument } from '@bike4mind/common';

const USER = { id: 'user-1', isAdmin: false };
const CONFIG: GitHubLakeAppConfig = {
  appId: 'app-1',
  slug: 'test-lake-app',
  privateKey: 'key',
  clientId: 'client-1',
  clientSecret: 'secret-1',
};

const ACTIVE_LAKE = { id: 'lake1', organizationId: 'orgA', status: 'active', origin: 'connector-fed', name: 'Lake 1' };

const INSTALLATION: GitHubLakeInstallation = {
  id: 42,
  accountLogin: 'acme',
  repositorySelection: 'selected',
  permissions: { contents: 'read', metadata: 'read' },
};

const REPO: GitHubLakeRepository = { id: 100, fullName: 'acme/one' };

const CONNECTION = {
  id: 'conn1',
  organizationId: 'orgA',
  installationId: 42,
} as unknown as IOrgGitHubLakeConnectionDocument;

describe('resolveConnectableLake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.dlFindById.mockResolvedValue(ACTIVE_LAKE);
    h.verifyOrgAccess.mockResolvedValue({ id: 'orgA' });
    h.ghConnFindByDataLakeIdAny.mockResolvedValue(null);
    h.driveConnFindByDataLakeIdAny.mockResolvedValue(null);
  });

  it('404s a missing lake', async () => {
    h.dlFindById.mockResolvedValue(null);
    await expect(resolveConnectableLake(USER, 'lake1')).rejects.toThrow(/not found/i);
    expect(h.verifyOrgAccess).not.toHaveBeenCalled();
  });

  it('400s a personal (org-less) lake', async () => {
    h.dlFindById.mockResolvedValue({ ...ACTIVE_LAKE, organizationId: undefined });
    await expect(resolveConnectableLake(USER, 'lake1')).rejects.toThrow(/organization-scoped/i);
    expect(h.verifyOrgAccess).not.toHaveBeenCalled();
  });

  it('verifies org access before checking the lake status', async () => {
    // If the status check ran first it would throw the 'archived' status message instead - this
    // proves verifyOrgAccess is the very first gate.
    h.dlFindById.mockResolvedValue({ ...ACTIVE_LAKE, status: 'archived' });
    h.verifyOrgAccess.mockRejectedValue(new Error('Organization not found'));
    await expect(resolveConnectableLake(USER, 'lake1')).rejects.toThrow('Organization not found');
    expect(h.ghConnFindByDataLakeIdAny).not.toHaveBeenCalled();
  });

  it('400s a non-ingestable lake status', async () => {
    h.dlFindById.mockResolvedValue({ ...ACTIVE_LAKE, status: 'archived' });
    await expect(resolveConnectableLake(USER, 'lake1')).rejects.toThrow(/'archived' status/i);
  });

  it('400s a curated-origin lake', async () => {
    h.dlFindById.mockResolvedValue({ ...ACTIVE_LAKE, origin: 'curated' });
    await expect(resolveConnectableLake(USER, 'lake1')).rejects.toThrow(/curated/i);
  });

  it('409s when a GitHub connection already feeds the lake', async () => {
    h.ghConnFindByDataLakeIdAny.mockResolvedValue({ id: 'existing-gh' });
    await expect(resolveConnectableLake(USER, 'lake1')).rejects.toThrow(/already connected to a GitHub/i);
  });

  it('409s when a Google Drive connection already feeds the lake', async () => {
    h.driveConnFindByDataLakeIdAny.mockResolvedValue({ id: 'existing-drive' });
    await expect(resolveConnectableLake(USER, 'lake1')).rejects.toThrow(/already connected to a Google Drive/i);
  });

  it('resolves the lake and org id on a clean connectable lake', async () => {
    await expect(resolveConnectableLake(USER, 'lake1')).resolves.toEqual({ lakeId: 'lake1', organizationId: 'orgA' });
  });
});

describe('completeGitHubLakeConnection', () => {
  const params = () => ({ config: CONFIG, user: USER, dataLakeId: 'lake1', installationId: 42, code: 'the-code' });

  beforeEach(() => {
    vi.clearAllMocks();
    h.dlFindById.mockResolvedValue(ACTIVE_LAKE);
    h.verifyOrgAccess.mockResolvedValue({ id: 'orgA' });
    h.ghConnFindByDataLakeIdAny.mockResolvedValue(null);
    h.driveConnFindByDataLakeIdAny.mockResolvedValue(null);
    h.exchangeInstallerCode.mockResolvedValue('user-token');
    h.listInstallerVisibleRepositories.mockResolvedValue([REPO]);
    h.revokeInstallerToken.mockResolvedValue(undefined);
    h.getInstallation.mockResolvedValue(INSTALLATION);
    h.ghConnFindByInstallationId.mockResolvedValue([]);
    h.ghConnCreate.mockResolvedValue({ id: 'conn1', repositoryId: REPO.id, repositoryFullName: REPO.fullName });
  });

  it('creates the connection with the picked repo, installation account, and connecting user', async () => {
    const result = await completeGitHubLakeConnection(params());
    expect(h.ghConnCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'orgA',
        targetDataLakeId: 'lake1',
        installationId: 42,
        accountLogin: 'acme',
        repositoryId: REPO.id,
        repositoryFullName: REPO.fullName,
        connectedBy: USER.id,
      })
    );
    expect(result).toEqual({ id: 'conn1', repositoryId: REPO.id, repositoryFullName: REPO.fullName });
  });

  it('revokes the installer token after a successful connect', async () => {
    await completeGitHubLakeConnection(params());
    expect(h.revokeInstallerToken).toHaveBeenCalledWith(CONFIG, 'user-token');
  });

  it('fails the code exchange and never lists repositories or creates a connection', async () => {
    h.exchangeInstallerCode.mockRejectedValue(new Error('bad code'));
    await expect(completeGitHubLakeConnection(params())).rejects.toThrow(/expired or was already used/i);
    expect(h.listInstallerVisibleRepositories).not.toHaveBeenCalled();
    expect(h.ghConnCreate).not.toHaveBeenCalled();
    expect(h.revokeInstallerToken).not.toHaveBeenCalled();
  });

  it('forbids a caller who cannot see the installation and never creates a connection', async () => {
    h.listInstallerVisibleRepositories.mockResolvedValue(null);
    await expect(completeGitHubLakeConnection(params())).rejects.toThrow(/do not have access/i);
    expect(h.ghConnCreate).not.toHaveBeenCalled();
    // The token was still minted for this check, so it is still revoked.
    expect(h.revokeInstallerToken).toHaveBeenCalledWith(CONFIG, 'user-token');
  });

  it('does not fail the connect when revoking the installer token rejects', async () => {
    h.revokeInstallerToken.mockRejectedValue(new Error('revoke failed'));
    await expect(completeGitHubLakeConnection(params())).resolves.toMatchObject({ id: 'conn1' });
  });

  it('revokes the installer token even when a later policy check fails', async () => {
    h.getInstallation.mockResolvedValue({ ...INSTALLATION, repositorySelection: 'all' });
    await expect(completeGitHubLakeConnection(params())).rejects.toThrow(/only select repositories/i);
    expect(h.revokeInstallerToken).toHaveBeenCalledWith(CONFIG, 'user-token');
    expect(h.ghConnCreate).not.toHaveBeenCalled();
  });

  it('rejects a policy-violating installation (all repositories) before creating a connection', async () => {
    h.getInstallation.mockResolvedValue({ ...INSTALLATION, repositorySelection: 'all' });
    await expect(completeGitHubLakeConnection(params())).rejects.toThrow(/only select repositories/i);
    expect(h.ghConnCreate).not.toHaveBeenCalled();
  });

  it('rejects when no unbound repository is visible', async () => {
    h.ghConnFindByInstallationId.mockResolvedValue([{ id: 'other', repositoryId: REPO.id }]);
    await expect(completeGitHubLakeConnection(params())).rejects.toThrow(/already connected to a data lake/i);
    expect(h.ghConnCreate).not.toHaveBeenCalled();
  });

  it('rejects when more than one unbound repository is visible (ambiguous)', async () => {
    h.listInstallerVisibleRepositories.mockResolvedValue([REPO, { id: 200, fullName: 'acme/two' }]);
    await expect(completeGitHubLakeConnection(params())).rejects.toThrow(/can read 2 repositories/i);
    expect(h.ghConnCreate).not.toHaveBeenCalled();
  });

  it('reports a conflict when create races another connect (duplicate key)', async () => {
    h.ghConnCreate.mockRejectedValue(Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }));
    await expect(completeGitHubLakeConnection(params())).rejects.toThrow(/just connected by another request/i);
  });
});

describe('verifyGitHubLakeState', () => {
  const nonceHash = 'nonce-hash-a';

  it('round-trips a valid token back to its dataLakeId', () => {
    const token = createStateToken(GITHUB_LAKE_STATE_OPTIONS, { userId: 'user-1', dataLakeId: 'lake1' }, nonceHash);
    expect(verifyGitHubLakeState(token, nonceHash, 'user-1')).toBe('lake1');
  });

  it('rejects a token minted for a different user', () => {
    const token = createStateToken(GITHUB_LAKE_STATE_OPTIONS, { userId: 'user-1', dataLakeId: 'lake1' }, nonceHash);
    expect(() => verifyGitHubLakeState(token, nonceHash, 'user-2')).toThrow(/invalid authorization state/i);
  });

  it('rejects a nonce mismatch', () => {
    const token = createStateToken(GITHUB_LAKE_STATE_OPTIONS, { userId: 'user-1', dataLakeId: 'lake1' }, nonceHash);
    expect(() => verifyGitHubLakeState(token, 'a-different-hash', 'user-1')).toThrow();
  });

  it('rejects a token minted for a different audience', () => {
    const token = createStateToken(
      { audience: 'google-drive-oauth-state', expiresIn: '10m' },
      { userId: 'user-1', dataLakeId: 'lake1' },
      nonceHash
    );
    expect(() => verifyGitHubLakeState(token, nonceHash, 'user-1')).toThrow();
  });
});

describe('buildGitHubLakeConnectUrls', () => {
  function makeRes() {
    const cookies: string[] = [];
    const res = {
      getHeader: () => (cookies.length ? cookies : undefined),
      setHeader: (_name: string, value: string | string[]) => {
        cookies.length = 0;
        cookies.push(...(Array.isArray(value) ? value : [value]));
      },
    } as unknown as Response;
    return { res, cookies };
  }

  it('returns an installUrl and authorizeUrl sharing one state token', () => {
    const { res } = makeRes();
    const { installUrl, authorizeUrl } = buildGitHubLakeConnectUrls(res, CONFIG, {
      userId: 'user-1',
      dataLakeId: 'lake1',
    });

    expect(installUrl).toMatch(new RegExp(`^https://github\\.com/apps/${CONFIG.slug}/installations/new\\?state=`));
    expect(authorizeUrl).toMatch(
      new RegExp(`^https://github\\.com/login/oauth/authorize\\?client_id=${CONFIG.clientId}&state=`)
    );
    expect(authorizeUrl).toMatch(/allow_signup=false/);

    const installState = new URL(installUrl).searchParams.get('state');
    const authorizeState = new URL(authorizeUrl).searchParams.get('state');
    expect(installState).toBe(authorizeState);
  });

  it('sets the github-lake-connect nonce cookie on the response', () => {
    const { res, cookies } = makeRes();
    buildGitHubLakeConnectUrls(res, CONFIG, { userId: 'user-1', dataLakeId: 'lake1' });
    const cookieName = `b4m_oauth_nonce_${NONCE_SLOT.githubLakeConnect}`;
    const setCookie = cookies.find(c => c.startsWith(`${cookieName}=`));
    expect(setCookie).toBeDefined();
    expect(setCookie).toMatch(/HttpOnly/);
  });
});

describe('releaseGitHubLakeConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.deleteInstallation.mockResolvedValue(undefined);
    h.ghConnRelease.mockResolvedValue(true);
  });

  it('uninstalls the App and releases the row when this is the last binding', async () => {
    h.ghConnFindByInstallationId.mockResolvedValue([CONNECTION]);
    const result = await releaseGitHubLakeConnection(CONNECTION, CONFIG);
    expect(h.deleteInstallation).toHaveBeenCalledWith(CONFIG, CONNECTION.installationId);
    expect(h.ghConnRelease).toHaveBeenCalledWith(CONNECTION.id, CONNECTION.organizationId);
    expect(result).toEqual({ installationRetained: false });
  });

  it('keeps the installation and only releases the row when a sibling binding remains', async () => {
    h.ghConnFindByInstallationId.mockResolvedValue([CONNECTION, { id: 'sibling', repositoryId: 999 }]);
    const result = await releaseGitHubLakeConnection(CONNECTION, CONFIG);
    expect(h.deleteInstallation).not.toHaveBeenCalled();
    expect(h.ghConnRelease).toHaveBeenCalledWith(CONNECTION.id, CONNECTION.organizationId);
    expect(result).toEqual({ installationRetained: true });
  });

  it('keeps the row for retry when the uninstall fails', async () => {
    h.ghConnFindByInstallationId.mockResolvedValue([CONNECTION]);
    h.deleteInstallation.mockRejectedValue(new Error('GitHub is down'));
    await expect(releaseGitHubLakeConnection(CONNECTION, CONFIG)).rejects.toThrow('GitHub is down');
    expect(h.ghConnRelease).not.toHaveBeenCalled();
  });

  it('throws when the App is unconfigured and this is the last binding, without releasing', async () => {
    h.ghConnFindByInstallationId.mockResolvedValue([CONNECTION]);
    await expect(releaseGitHubLakeConnection(CONNECTION, null)).rejects.toThrow(/not configured/i);
    expect(h.deleteInstallation).not.toHaveBeenCalled();
    expect(h.ghConnRelease).not.toHaveBeenCalled();
  });
});

describe('releaseGitHubLakeConnectionForLake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getGitHubLakeAppConfig.mockReturnValue(CONFIG);
    h.deleteInstallation.mockResolvedValue(undefined);
    h.ghConnRelease.mockResolvedValue(true);
  });

  it('returns null and releases nothing when the lake has no GitHub connection', async () => {
    h.ghConnFindByDataLakeIdAny.mockResolvedValue(null);
    await expect(releaseGitHubLakeConnectionForLake('lake1')).resolves.toBeNull();
    expect(h.deleteInstallation).not.toHaveBeenCalled();
    expect(h.ghConnRelease).not.toHaveBeenCalled();
  });

  it('delegates to releaseGitHubLakeConnection and returns its installationRetained result', async () => {
    h.ghConnFindByDataLakeIdAny.mockResolvedValue(CONNECTION);
    h.ghConnFindByInstallationId.mockResolvedValue([CONNECTION]);
    await expect(releaseGitHubLakeConnectionForLake('lake1')).resolves.toEqual({ installationRetained: false });
    expect(h.deleteInstallation).toHaveBeenCalledWith(CONFIG, CONNECTION.installationId);
    expect(h.ghConnRelease).toHaveBeenCalledWith(CONNECTION.id, CONNECTION.organizationId);
  });
});
