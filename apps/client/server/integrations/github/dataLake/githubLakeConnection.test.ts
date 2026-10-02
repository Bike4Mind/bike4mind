import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { Response } from 'express';
import { createStateToken } from '@server/auth/jwtStateStore';
import { NONCE_SLOT } from '@server/auth/oauthFlowCookie';
import { Logger } from '@bike4mind/observability';
import { ForbiddenError } from '@server/utils/errors';
import { GRANT_EXPIRED_MESSAGE } from './githubLakeAuthGrant';

const h = vi.hoisted(() => ({
  exchangeInstallerCode: vi.fn(),
  listInstallerVisibleRepositories: vi.fn(),
  listUserInstallations: vi.fn(),
  revokeInstallerToken: vi.fn(),
  getInstallation: vi.fn(),
  deleteInstallation: vi.fn(),
  getGitHubLakeAppConfig: vi.fn(),
  verifyOrgAccess: vi.fn(),
  dlFindById: vi.fn(),
  ghConnFindByDataLakeIdAny: vi.fn(),
  ghConnFindByInstallationId: vi.fn(),
  ghConnFindById: vi.fn(),
  ghConnFindByRepositoryIds: vi.fn(),
  ghConnCreate: vi.fn(),
  ghConnRelease: vi.fn(),
  ghConnSetEnabledForLake: vi.fn(),
  ghConnRecordLastError: vi.fn(),
  ghConnDisableIfNoLiveSyncClaim: vi.fn(),
  fabFilesFindByGitHubConnectionIdInDataLake: vi.fn(),
  purgeConnectionIngestedFiles: vi.fn(),
  driveConnFindByDataLakeIdAny: vi.fn(),
  sendToQueue: vi.fn(),
  requireGitHubLakeFlowNonce: vi.fn(),
  storeGitHubLakeAuthGrant: vi.fn(),
  readGitHubLakeUserToken: vi.fn(),
  consumeGitHubLakeAuthGrant: vi.fn(),
}));

vi.mock('./lakeAppClient', async importOriginal => {
  const actual = await importOriginal<typeof import('./lakeAppClient')>();
  return {
    ...actual,
    exchangeInstallerCode: h.exchangeInstallerCode,
    listInstallerVisibleRepositories: h.listInstallerVisibleRepositories,
    listUserInstallations: h.listUserInstallations,
    revokeInstallerToken: h.revokeInstallerToken,
    getInstallation: h.getInstallation,
    deleteInstallation: h.deleteInstallation,
    getGitHubLakeAppConfig: h.getGitHubLakeAppConfig,
  };
});
// The grant store has its own dedicated unit tests (githubLakeAuthGrant.test.ts).
vi.mock('./githubLakeAuthGrant', async importOriginal => {
  const actual = await importOriginal<typeof import('./githubLakeAuthGrant')>();
  return {
    ...actual,
    requireGitHubLakeFlowNonce: h.requireGitHubLakeFlowNonce,
    storeGitHubLakeAuthGrant: h.storeGitHubLakeAuthGrant,
    readGitHubLakeUserToken: h.readGitHubLakeUserToken,
    consumeGitHubLakeAuthGrant: h.consumeGitHubLakeAuthGrant,
  };
});
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess: h.verifyOrgAccess }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
// The sweep itself is covered by purgeDataLakeConnectionFiles's unit tests and the GitHub ingest e2e.
vi.mock('@server/dataLakes/purgeConnectionIngestedFiles', () => ({
  purgeConnectionIngestedFiles: h.purgeConnectionIngestedFiles,
}));
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    dataLakeRepository: { ...actual.dataLakeRepository, findById: h.dlFindById },
    orgGitHubLakeConnectionRepository: {
      ...actual.orgGitHubLakeConnectionRepository,
      findByDataLakeIdAny: h.ghConnFindByDataLakeIdAny,
      findByInstallationId: h.ghConnFindByInstallationId,
      findByRepositoryIds: h.ghConnFindByRepositoryIds,
      findById: h.ghConnFindById,
      create: h.ghConnCreate,
      release: h.ghConnRelease,
      setEnabledForLake: h.ghConnSetEnabledForLake,
      recordLastError: h.ghConnRecordLastError,
      disableIfNoLiveSyncClaim: h.ghConnDisableIfNoLiveSyncClaim,
    },
    fabFileRepository: {
      ...actual.fabFileRepository,
      findByGitHubConnectionIdInDataLake: h.fabFilesFindByGitHubConnectionIdInDataLake,
    },
    orgGoogleDriveConnectionRepository: {
      ...actual.orgGoogleDriveConnectionRepository,
      findByDataLakeIdAny: h.driveConnFindByDataLakeIdAny,
    },
  };
});

import {
  resolveConnectableLake,
  authorizeGitHubLakeConnection,
  completeGitHubLakeConnection,
  listGitHubLakeRepositoryChoices,
  verifyGitHubLakeState,
  buildGitHubLakeAuthorizeUrl,
  releaseGitHubLakeConnection,
  releaseGitHubLakeConnectionForLake,
  disconnectGitHubLakeConnection,
  revokeGitHubLakeConnection,
  disableGitHubConnectionForLake,
  enableGitHubConnectionForLake,
  toGitHubLakeConnectionResponse,
  GITHUB_LAKE_STATE_OPTIONS,
  REVOKE_PURGE_SLICE_SIZE,
} from './githubLakeConnection';
import type {
  GitHubLakeAppConfig,
  GitHubLakeInstallation,
  GitHubLakeRepository,
  GitHubLakeUserInstallation,
} from './lakeAppClient';
import type { IOrgGitHubLakeConnectionDocument } from '@bike4mind/common';

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn() } as never;
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

const REPO: GitHubLakeRepository = { id: 100, fullName: 'acme/one', defaultBranch: 'main', private: true };

const USER_INSTALLATION: GitHubLakeUserInstallation = {
  id: 42,
  accountLogin: 'acme',
  accountId: 9001,
  accountType: 'Organization',
  settingsUrl: 'https://github.com/organizations/acme/settings/installations/42',
  repositorySelection: 'selected',
  permissions: { contents: 'read', metadata: 'read' },
};

const CONNECTION = {
  id: 'conn1',
  organizationId: 'orgA',
  installationId: 42,
} as unknown as IOrgGitHubLakeConnectionDocument;

describe('toGitHubLakeConnectionResponse', () => {
  const connectedAt = new Date('2026-01-01');
  const base = {
    id: 'conn1',
    accountLogin: 'acme',
    repositoryId: 100,
    repositoryFullName: 'acme/one',
    connectedBy: 'user-1',
    connectedAt,
  };

  it('exposes sync state and the file count, never credentials or claim fields', () => {
    const lastSyncedAt = new Date('2026-02-01');
    const conn = {
      ...base,
      installationId: 42,
      enabled: false,
      status: 'error',
      lastError: 'Repository access was removed',
      defaultBranch: 'main',
      lastSyncedAt,
      lastSyncedCommitSha: 'sha-1',
      syncClaimedAt: new Date(),
      ingestClaimToken: 'token-1',
    } as unknown as IOrgGitHubLakeConnectionDocument;

    expect(toGitHubLakeConnectionResponse(conn, 5)).toEqual({
      ...base,
      enabled: false,
      status: 'error',
      lastError: 'Repository access was removed',
      defaultBranch: 'main',
      lastSyncedAt,
      syncStale: false,
      fileCount: 5,
    });
  });

  it('fills the model defaults for a row that predates them', () => {
    const conn = base as unknown as IOrgGitHubLakeConnectionDocument;
    expect(toGitHubLakeConnectionResponse(conn, 0)).toMatchObject({
      enabled: true,
      status: 'connected',
      lastError: null,
      defaultBranch: null,
      lastSyncedAt: null,
      syncStale: false,
    });
  });

  // @bike4mind/database is mocked above with importOriginal and only overrides specific repository
  // methods, so isGitHubLakeSyncClaimLive itself is the real implementation here.
  it('marks a syncing row syncStale once its claim is older than the 20-minute window', () => {
    const conn = {
      ...base,
      status: 'syncing',
      syncClaimedAt: new Date(Date.now() - 21 * 60 * 1000),
      activeIngestBatchId: null,
    } as unknown as IOrgGitHubLakeConnectionDocument;
    expect(toGitHubLakeConnectionResponse(conn, 0)).toMatchObject({ syncStale: true });
  });

  it('does not mark a syncing row syncStale while its claim is fresh', () => {
    const conn = {
      ...base,
      status: 'syncing',
      syncClaimedAt: new Date(Date.now() - 60 * 1000),
      activeIngestBatchId: null,
    } as unknown as IOrgGitHubLakeConnectionDocument;
    expect(toGitHubLakeConnectionResponse(conn, 0)).toMatchObject({ syncStale: false });
  });

  it('never reads a connected row as syncStale, regardless of an old syncClaimedAt', () => {
    const conn = {
      ...base,
      status: 'connected',
      syncClaimedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    } as unknown as IOrgGitHubLakeConnectionDocument;
    expect(toGitHubLakeConnectionResponse(conn, 0)).toMatchObject({ syncStale: false });
  });
});

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

// Default behavior shared by every describe below that reaches readGitHubLakeUserToken /
// requireGitHubLakeFlowNonce through the mocked './githubLakeAuthGrant' module.
function mockLiveGrant(userToken = 'user-token') {
  h.requireGitHubLakeFlowNonce.mockImplementation((nh: string | null) => {
    if (!nh) throw new ForbiddenError('Your GitHub authorization expired. Connect GitHub again.');
    return nh;
  });
  h.readGitHubLakeUserToken.mockResolvedValue(userToken);
}

describe('authorizeGitHubLakeConnection', () => {
  const NONCE_HASH = 'nonce-hash-a';
  const validState = (dataLakeId = 'lake1') =>
    createStateToken(GITHUB_LAKE_STATE_OPTIONS, { userId: USER.id, dataLakeId }, NONCE_HASH);
  const params = (overrides: Partial<Parameters<typeof authorizeGitHubLakeConnection>[0]> = {}) => ({
    config: CONFIG,
    user: USER,
    state: validState(),
    code: 'the-code',
    nonceHash: NONCE_HASH,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.dlFindById.mockResolvedValue(ACTIVE_LAKE);
    h.verifyOrgAccess.mockResolvedValue({ id: 'orgA' });
    h.ghConnFindByDataLakeIdAny.mockResolvedValue(null);
    h.driveConnFindByDataLakeIdAny.mockResolvedValue(null);
    h.exchangeInstallerCode.mockResolvedValue('user-token');
    h.storeGitHubLakeAuthGrant.mockResolvedValue(undefined);
    mockLiveGrant();
  });

  it('403s a bad/forged state token', async () => {
    await expect(authorizeGitHubLakeConnection(params({ state: 'garbage' }))).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(h.exchangeInstallerCode).not.toHaveBeenCalled();
  });

  it('403s when this browser has no nonce cookie for the flow', async () => {
    await expect(authorizeGitHubLakeConnection(params({ nonceHash: null }))).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(h.exchangeInstallerCode).not.toHaveBeenCalled();
  });

  it('fails a lake that cannot take a connection before exchanging the code', async () => {
    h.dlFindById.mockResolvedValue({ ...ACTIVE_LAKE, status: 'archived' });
    await expect(authorizeGitHubLakeConnection(params())).rejects.toThrow(/'archived' status/i);
    expect(h.exchangeInstallerCode).not.toHaveBeenCalled();
  });

  it('400s a failed code exchange and stores no grant', async () => {
    h.exchangeInstallerCode.mockRejectedValue(new Error('bad code'));
    await expect(authorizeGitHubLakeConnection(params())).rejects.toMatchObject({ statusCode: 400 });
    expect(h.storeGitHubLakeAuthGrant).not.toHaveBeenCalled();
  });

  it('logs a failed code exchange without the request body that carries the client secret', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const httpError = Object.assign(new Error('The client_id and/or client_secret passed are incorrect.'), {
      name: 'HttpError',
      status: 400,
      request: { body: { client_id: 'cid', client_secret: 'super-secret', code: 'the-code' } },
    });
    h.exchangeInstallerCode.mockRejectedValue(httpError);
    await expect(authorizeGitHubLakeConnection(params())).rejects.toThrow(/expired or was already used/i);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('client_secret passed are incorrect');
    expect(logged).not.toContain('super-secret');
    expect(logged).not.toContain('the-code');
    warn.mockRestore();
  });

  it('stores the grant for this nonce, user, and lake on success and returns the lake id', async () => {
    await expect(authorizeGitHubLakeConnection(params())).resolves.toEqual({ dataLakeId: 'lake1' });
    expect(h.storeGitHubLakeAuthGrant).toHaveBeenCalledWith(CONFIG, {
      nonceHash: NONCE_HASH,
      userId: USER.id,
      dataLakeId: 'lake1',
      userToken: 'user-token',
    });
  });
});

describe('listGitHubLakeRepositoryChoices', () => {
  const NONCE_HASH = 'nonce-hash-a';
  const params = () => ({ config: CONFIG, user: USER, dataLakeId: 'lake1', nonceHash: NONCE_HASH });

  beforeEach(() => {
    vi.clearAllMocks();
    h.dlFindById.mockResolvedValue(ACTIVE_LAKE);
    h.verifyOrgAccess.mockResolvedValue({ id: 'orgA' });
    h.ghConnFindByDataLakeIdAny.mockResolvedValue(null);
    h.driveConnFindByDataLakeIdAny.mockResolvedValue(null);
    mockLiveGrant();
    h.listUserInstallations.mockResolvedValue([USER_INSTALLATION]);
    h.listInstallerVisibleRepositories.mockResolvedValue([REPO]);
    h.ghConnFindByRepositoryIds.mockResolvedValue([]);
    h.consumeGitHubLakeAuthGrant.mockResolvedValue(undefined);
  });

  it('403s when the flow holds no live grant', async () => {
    h.readGitHubLakeUserToken.mockRejectedValue(new ForbiddenError('expired'));
    await expect(listGitHubLakeRepositoryChoices(params())).rejects.toMatchObject({ statusCode: 403 });
  });

  it('403s a GitHub 401 on the held user token (listUserInstallations) with the expired-grant message', async () => {
    h.listUserInstallations.mockRejectedValue(Object.assign(new Error('Bad credentials'), { status: 401 }));
    await expect(listGitHubLakeRepositoryChoices(params())).rejects.toMatchObject({
      statusCode: 403,
      message: GRANT_EXPIRED_MESSAGE,
    });
    expect(h.consumeGitHubLakeAuthGrant).toHaveBeenCalledWith(CONFIG, NONCE_HASH);
  });

  it('403s a GitHub 401 on the held user token (listInstallerVisibleRepositories) with the expired-grant message', async () => {
    h.listInstallerVisibleRepositories.mockRejectedValue(Object.assign(new Error('Bad credentials'), { status: 401 }));
    await expect(listGitHubLakeRepositoryChoices(params())).rejects.toMatchObject({
      statusCode: 403,
      message: GRANT_EXPIRED_MESSAGE,
    });
    expect(h.consumeGitHubLakeAuthGrant).toHaveBeenCalledWith(CONFIG, NONCE_HASH);
  });

  it('lists an installUrl bound to the same flow nonce', async () => {
    const result = await listGitHubLakeRepositoryChoices(params());
    expect(result.installUrl).toMatch(
      new RegExp(`^https://github\\.com/apps/${CONFIG.slug}/installations/new\\?state=`)
    );
  });

  it('gives each installation an addRepositoriesUrl targeted at its account and bound to the same flow', async () => {
    const result = await listGitHubLakeRepositoryChoices(params());
    const url = new URL(result.installations[0].addRepositoriesUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`https://github.com/apps/${CONFIG.slug}/installations/new/permissions`);
    expect(url.searchParams.get('target_id')).toBe('9001');
    // Signed into the same flow as the install fallback, so its return reopens this lake's picker.
    expect(verifyGitHubLakeState(url.searchParams.get('state') ?? '', NONCE_HASH, USER.id)).toBe('lake1');
  });

  it('keeps the addRepositoriesUrl on a policy-violating installation too', async () => {
    h.listUserInstallations.mockResolvedValue([{ ...USER_INSTALLATION, repositorySelection: 'all' }]);
    const result = await listGitHubLakeRepositoryChoices(params());
    expect(new URL(result.installations[0].addRepositoriesUrl).searchParams.get('target_id')).toBe('9001');
  });

  it('falls back to the untargeted installUrl when the installation has no account id', async () => {
    h.listUserInstallations.mockResolvedValue([{ ...USER_INSTALLATION, accountId: null }]);
    const result = await listGitHubLakeRepositoryChoices(params());
    expect(result.installations[0].addRepositoriesUrl).toBe(result.installUrl);
  });

  it('lists a policy-violating installation with the violation and empty repositories, never listing its repos', async () => {
    h.listUserInstallations.mockResolvedValue([{ ...USER_INSTALLATION, repositorySelection: 'all' }]);
    const result = await listGitHubLakeRepositoryChoices(params());
    expect(result.installations).toEqual([
      expect.objectContaining({
        id: USER_INSTALLATION.id,
        violation: { code: 'all_repositories', message: expect.stringMatching(/only select repositories/i) },
        repositories: [],
      }),
    ]);
    expect(h.listInstallerVisibleRepositories).not.toHaveBeenCalled();
  });

  it('leaves an unbound repository boundTo null', async () => {
    const result = await listGitHubLakeRepositoryChoices(params());
    expect(result.installations[0].repositories[0]).toMatchObject({ id: REPO.id, boundTo: null });
  });

  it('names the lake for a repository already bound within the caller org', async () => {
    h.ghConnFindByRepositoryIds.mockResolvedValue([
      { repositoryId: REPO.id, organizationId: 'orgA', targetDataLakeId: 'lake-other' },
    ]);
    h.dlFindById.mockImplementation(async (id: string) =>
      id === 'lake-other' ? { id: 'lake-other', name: 'Other Lake' } : ACTIVE_LAKE
    );
    const result = await listGitHubLakeRepositoryChoices(params());
    expect(result.installations[0].repositories[0].boundTo).toEqual({ dataLakeName: 'Other Lake' });
  });

  it('hides the lake name for a repository bound in a different organization', async () => {
    h.ghConnFindByRepositoryIds.mockResolvedValue([
      { repositoryId: REPO.id, organizationId: 'orgB', targetDataLakeId: 'lake-foreign' },
    ]);
    const result = await listGitHubLakeRepositoryChoices(params());
    expect(result.installations[0].repositories[0].boundTo).toEqual({ dataLakeName: null });
    // Cross-org lake names are never fetched - the caller has no right to see them.
    expect(h.dlFindById).toHaveBeenCalledTimes(1);
  });
});

describe('completeGitHubLakeConnection', () => {
  const NONCE_HASH = 'nonce-hash-a';
  const params = () => ({
    config: CONFIG,
    user: USER,
    dataLakeId: 'lake1',
    nonceHash: NONCE_HASH,
    installationId: 42,
    repositoryId: REPO.id,
    logger,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.dlFindById.mockResolvedValue(ACTIVE_LAKE);
    h.verifyOrgAccess.mockResolvedValue({ id: 'orgA' });
    h.ghConnFindByDataLakeIdAny.mockResolvedValue(null);
    h.driveConnFindByDataLakeIdAny.mockResolvedValue(null);
    mockLiveGrant();
    h.listInstallerVisibleRepositories.mockResolvedValue([REPO]);
    h.getInstallation.mockResolvedValue(INSTALLATION);
    h.ghConnCreate.mockResolvedValue({ id: 'conn1', repositoryId: REPO.id, repositoryFullName: REPO.fullName });
    h.consumeGitHubLakeAuthGrant.mockResolvedValue(undefined);
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

  it('consumes the flow grant after a successful connect', async () => {
    await completeGitHubLakeConnection(params());
    expect(h.consumeGitHubLakeAuthGrant).toHaveBeenCalledWith(CONFIG, NONCE_HASH);
  });

  // Acceptance criterion: a caller cannot name a repository it was never shown - the server
  // re-verifies the pick against the flow's own user token, never trusting the browser's id.
  it('rejects a repositoryId not visible to the user token through that installation', async () => {
    h.listInstallerVisibleRepositories.mockResolvedValue([{ ...REPO, id: 999, fullName: 'acme/other' }]);
    await expect(completeGitHubLakeConnection(params())).rejects.toMatchObject({ statusCode: 403 });
    expect(h.ghConnCreate).not.toHaveBeenCalled();
    expect(h.consumeGitHubLakeAuthGrant).not.toHaveBeenCalled();
  });

  it('rejects when the installation is not visible to the user token at all (null)', async () => {
    h.listInstallerVisibleRepositories.mockResolvedValue(null);
    await expect(completeGitHubLakeConnection(params())).rejects.toMatchObject({ statusCode: 403 });
    expect(h.ghConnCreate).not.toHaveBeenCalled();
  });

  it('403s a GitHub 401 on the held user token (listInstallerVisibleRepositories) with the expired-grant message', async () => {
    h.listInstallerVisibleRepositories.mockRejectedValue(Object.assign(new Error('Bad credentials'), { status: 401 }));
    await expect(completeGitHubLakeConnection(params())).rejects.toMatchObject({
      statusCode: 403,
      message: GRANT_EXPIRED_MESSAGE,
    });
    expect(h.consumeGitHubLakeAuthGrant).toHaveBeenCalledWith(CONFIG, NONCE_HASH);
    expect(h.ghConnCreate).not.toHaveBeenCalled();
  });

  it('403s an expired or mismatched grant before listing any repositories', async () => {
    h.readGitHubLakeUserToken.mockRejectedValue(new ForbiddenError('Your GitHub authorization expired.'));
    await expect(completeGitHubLakeConnection(params())).rejects.toMatchObject({ statusCode: 403 });
    expect(h.listInstallerVisibleRepositories).not.toHaveBeenCalled();
    expect(h.ghConnCreate).not.toHaveBeenCalled();
  });

  it('400s a policy-violating installation (all repositories) before creating a connection', async () => {
    h.getInstallation.mockResolvedValue({ ...INSTALLATION, repositorySelection: 'all' });
    await expect(completeGitHubLakeConnection(params())).rejects.toMatchObject({ statusCode: 400 });
    await expect(completeGitHubLakeConnection(params())).rejects.toThrow(/only select repositories/i);
    expect(h.ghConnCreate).not.toHaveBeenCalled();
  });

  it('409s when create races another connect (duplicate key)', async () => {
    h.ghConnCreate.mockRejectedValue(Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }));
    await expect(completeGitHubLakeConnection(params())).rejects.toMatchObject({ statusCode: 409 });
  });

  it('does not fail the connect when consuming the flow grant rejects (best-effort, logged)', async () => {
    h.consumeGitHubLakeAuthGrant.mockRejectedValue(new Error('consume failed'));
    await expect(completeGitHubLakeConnection(params())).resolves.toMatchObject({ id: 'conn1' });
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('completeGitHubLakeConnection - first ingest', () => {
  const NONCE_HASH = 'nonce-hash-a';
  const params = () => ({
    config: CONFIG,
    user: USER,
    dataLakeId: 'lake1',
    nonceHash: NONCE_HASH,
    installationId: 42,
    repositoryId: REPO.id,
    logger,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.dlFindById.mockResolvedValue(ACTIVE_LAKE);
    h.verifyOrgAccess.mockResolvedValue({ id: 'orgA' });
    h.ghConnFindByDataLakeIdAny.mockResolvedValue(null);
    h.driveConnFindByDataLakeIdAny.mockResolvedValue(null);
    mockLiveGrant();
    h.listInstallerVisibleRepositories.mockResolvedValue([REPO]);
    h.getInstallation.mockResolvedValue(INSTALLATION);
    h.ghConnCreate.mockResolvedValue({ id: 'conn1', repositoryId: REPO.id, repositoryFullName: REPO.fullName });
    h.consumeGitHubLakeAuthGrant.mockResolvedValue(undefined);
    h.sendToQueue.mockResolvedValue(undefined);
    h.ghConnRecordLastError.mockResolvedValue(true);
  });

  it('enqueues the first ingest right after binding', async () => {
    await completeGitHubLakeConnection(params());
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.test/githubLakeIngestQueue', { connectionId: 'conn1' });
    expect(h.ghConnRecordLastError).not.toHaveBeenCalled();
  });

  it('still completes the connect when the enqueue fails, records lastError, and leaves a manual re-sync to run it', async () => {
    h.sendToQueue.mockRejectedValue(new Error('sqs down'));
    await expect(completeGitHubLakeConnection(params())).resolves.toMatchObject({ id: 'conn1' });
    expect(h.ghConnRecordLastError).toHaveBeenCalledWith(
      'conn1',
      'Initial sync could not be queued. Re-sync to start.'
    );
  });

  it('does not fail the connect when recording the enqueue failure also fails', async () => {
    h.sendToQueue.mockRejectedValue(new Error('sqs down'));
    h.ghConnRecordLastError.mockRejectedValue(new Error('db down'));
    await expect(completeGitHubLakeConnection(params())).resolves.toMatchObject({ id: 'conn1' });
  });

  it('enqueues nothing when the binding loses its race', async () => {
    h.ghConnCreate.mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    await expect(completeGitHubLakeConnection(params())).rejects.toThrow();
    expect(h.sendToQueue).not.toHaveBeenCalled();
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

describe('buildGitHubLakeAuthorizeUrl', () => {
  const ORIGINAL_APP_URL = process.env.APP_URL;

  beforeEach(() => {
    process.env.APP_URL = 'https://app.test';
  });

  afterAll(() => {
    process.env.APP_URL = ORIGINAL_APP_URL;
  });

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

  it('carries client_id, state, allow_signup=false, and a redirect_uri built from APP_URL', () => {
    const { res } = makeRes();
    const url = new URL(buildGitHubLakeAuthorizeUrl(res, CONFIG, { userId: 'user-1', dataLakeId: 'lake1' }));

    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(CONFIG.clientId);
    expect(url.searchParams.get('allow_signup')).toBe('false');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/data-lakes/github/callback');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('sets the github-lake-connect nonce cookie on the response', () => {
    const { res, cookies } = makeRes();
    buildGitHubLakeAuthorizeUrl(res, CONFIG, { userId: 'user-1', dataLakeId: 'lake1' });
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

  it('still uninstalls when a concurrent release took the sibling binding first (no binding remains after ours)', async () => {
    const calls: string[] = [];
    h.ghConnFindByInstallationId
      .mockResolvedValueOnce([CONNECTION, { id: 'sibling', repositoryId: 999 }])
      .mockResolvedValueOnce([]);
    h.ghConnRelease.mockImplementation(async () => (calls.push('release'), true));
    h.deleteInstallation.mockImplementation(async () => void calls.push('uninstall'));
    const result = await releaseGitHubLakeConnection(CONNECTION, CONFIG);
    expect(calls).toEqual(['release', 'uninstall']);
    expect(h.deleteInstallation).toHaveBeenCalledWith(CONFIG, CONNECTION.installationId);
    expect(result).toEqual({ installationRetained: false });
  });

  it('keeps the row for retry when the uninstall fails', async () => {
    h.ghConnFindByInstallationId.mockResolvedValue([CONNECTION]);
    h.deleteInstallation.mockRejectedValue(new Error('GitHub is down'));
    await expect(releaseGitHubLakeConnection(CONNECTION, CONFIG)).rejects.toThrow('GitHub is down');
    expect(h.ghConnRelease).not.toHaveBeenCalled();
  });

  it('queues a revoke retry when a concurrent release s own row is already gone but its uninstall failed, and resolves not-retained', async () => {
    // Two bindings (A, B) share an installation. B's release wins the recount race and sees no
    // sibling left, but its uninstall call fails (a non-404 GitHub error), so B's row is already
    // deleted while the App is still installed. The failed uninstall is handed to the revoke
    // queue instead of rejecting, and that retry must finish the uninstall since
    // revokeGitHubLakeConnection can no longer find B.
    const A = {
      id: 'connA',
      organizationId: 'orgA',
      installationId: 42,
    } as unknown as IOrgGitHubLakeConnectionDocument;
    const B = {
      id: 'connB',
      organizationId: 'orgA',
      installationId: 42,
    } as unknown as IOrgGitHubLakeConnectionDocument;

    h.ghConnFindByInstallationId.mockResolvedValueOnce([A, B]).mockResolvedValueOnce([]);
    h.deleteInstallation.mockRejectedValueOnce(Object.assign(new Error('GitHub API is unavailable'), { status: 502 }));
    h.sendToQueue.mockResolvedValue(undefined);
    await expect(releaseGitHubLakeConnection(B, CONFIG)).resolves.toEqual({ installationRetained: false });
    expect(h.ghConnRelease).toHaveBeenCalledWith(B.id, B.organizationId);
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.test/githubLakeRevokeQueue', {
      connectionId: B.id,
      installationId: B.installationId,
    });

    h.ghConnFindById.mockResolvedValue(null);
    h.ghConnFindByInstallationId.mockResolvedValue([]);
    h.getGitHubLakeAppConfig.mockReturnValue(CONFIG);
    h.deleteInstallation.mockResolvedValueOnce(undefined);
    await expect(
      revokeGitHubLakeConnection({ connectionId: B.id, installationId: B.installationId }, logger)
    ).resolves.toBeUndefined();
    expect(h.deleteInstallation).toHaveBeenLastCalledWith(CONFIG, B.installationId);
  });

  it('rethrows the original uninstall error when the revoke-queue hand-off also fails', async () => {
    const B = {
      id: 'connB',
      organizationId: 'orgA',
      installationId: 42,
    } as unknown as IOrgGitHubLakeConnectionDocument;

    h.ghConnFindByInstallationId.mockResolvedValueOnce([CONNECTION, B]).mockResolvedValueOnce([]);
    const uninstallError = Object.assign(new Error('GitHub API is unavailable'), { status: 502 });
    h.deleteInstallation.mockRejectedValueOnce(uninstallError);
    h.sendToQueue.mockRejectedValue(new Error('sqs down'));
    await expect(releaseGitHubLakeConnection(B, CONFIG)).rejects.toBe(uninstallError);
    expect(h.ghConnRelease).toHaveBeenCalledWith(B.id, B.organizationId);
  });

  it('throws when the App is unconfigured and this is the last binding, without releasing', async () => {
    h.ghConnFindByInstallationId.mockResolvedValue([CONNECTION]);
    await expect(releaseGitHubLakeConnection(CONNECTION, null)).rejects.toThrow(/not configured/i);
    expect(h.deleteInstallation).not.toHaveBeenCalled();
    expect(h.ghConnRelease).not.toHaveBeenCalled();
  });
});

describe('disconnectGitHubLakeConnection', () => {
  const LAKE = { id: 'lake1', organizationId: 'orgA', datalakeTag: 'datalake:lake1' } as never;
  const FILES = [{ id: 'f1' }];
  let calls: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    h.getGitHubLakeAppConfig.mockReturnValue(CONFIG);
    h.ghConnFindByInstallationId.mockResolvedValue([CONNECTION]);
    h.fabFilesFindByGitHubConnectionIdInDataLake.mockResolvedValue(FILES);
    h.ghConnDisableIfNoLiveSyncClaim.mockImplementation(async () => (calls.push('disable'), { wasEnabled: true }));
    h.purgeConnectionIngestedFiles.mockImplementation(
      async (_lake, findFiles: (limit?: number) => Promise<unknown>) => {
        calls.push('purge');
        await findFiles();
        return { remaining: false };
      }
    );
    h.deleteInstallation.mockImplementation(async () => void calls.push('uninstall'));
    h.ghConnRelease.mockImplementation(async () => (calls.push('release'), true));
    h.ghConnSetEnabledForLake.mockImplementation(async () => (calls.push('enable'), true));
  });

  it('disables, purges the connection s files, then releases', async () => {
    await expect(disconnectGitHubLakeConnection(LAKE, CONNECTION, logger)).resolves.toEqual({
      installationRetained: false,
    });
    expect(calls).toEqual(['disable', 'purge', 'uninstall', 'release']);
    expect(h.ghConnDisableIfNoLiveSyncClaim).toHaveBeenCalledWith('conn1', 'orgA');
    expect(h.fabFilesFindByGitHubConnectionIdInDataLake).toHaveBeenCalledWith('conn1', 'datalake:lake1', {
      includeDeleted: true,
    });
    expect(h.purgeConnectionIngestedFiles).toHaveBeenCalledWith(
      LAKE,
      expect.any(Function),
      expect.objectContaining({ connectionId: 'conn1', logger })
    );
  });

  it('409s while a sync claim is live, touching nothing', async () => {
    h.ghConnDisableIfNoLiveSyncClaim.mockResolvedValue(null);
    await expect(disconnectGitHubLakeConnection(LAKE, CONNECTION, logger)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(h.purgeConnectionIngestedFiles).not.toHaveBeenCalled();
    expect(h.ghConnRelease).not.toHaveBeenCalled();
  });

  it('keeps the row when the purge fails, and hands the purge a re-enable restore', async () => {
    h.purgeConnectionIngestedFiles.mockRejectedValue(new Error('storage blip'));
    await expect(disconnectGitHubLakeConnection(LAKE, CONNECTION, logger)).rejects.toThrow('storage blip');
    expect(h.deleteInstallation).not.toHaveBeenCalled();
    expect(h.ghConnRelease).not.toHaveBeenCalled();
    await h.purgeConnectionIngestedFiles.mock.calls[0][2].restore();
    expect(h.ghConnSetEnabledForLake).toHaveBeenCalledWith('lake1', true);
  });

  it('passes no restore for an already-disabled (archived) connection', async () => {
    h.ghConnDisableIfNoLiveSyncClaim.mockResolvedValue({ wasEnabled: false });
    await disconnectGitHubLakeConnection(LAKE, CONNECTION, logger);
    expect(h.purgeConnectionIngestedFiles.mock.calls[0][2].restore).toBeUndefined();
  });

  it('forwards the limit the purge finder is called with to the fab file finder', async () => {
    await disconnectGitHubLakeConnection(LAKE, CONNECTION, logger);
    const findFiles = h.purgeConnectionIngestedFiles.mock.calls[0][1] as (limit?: number) => Promise<unknown>;
    await findFiles(5);
    expect(h.fabFilesFindByGitHubConnectionIdInDataLake).toHaveBeenLastCalledWith('conn1', 'datalake:lake1', {
      includeDeleted: true,
      limit: 5,
    });
  });
});

describe('revokeGitHubLakeConnection', () => {
  const LAKE = { id: 'lake1', organizationId: 'orgA', datalakeTag: 'datalake:lake1' } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    h.getGitHubLakeAppConfig.mockReturnValue(CONFIG);
    h.ghConnFindById.mockResolvedValue(CONNECTION);
    h.dlFindById.mockResolvedValue(LAKE);
    h.ghConnFindByInstallationId.mockResolvedValue([CONNECTION]);
    h.fabFilesFindByGitHubConnectionIdInDataLake.mockResolvedValue([]);
    h.ghConnDisableIfNoLiveSyncClaim.mockResolvedValue({ wasEnabled: true });
    h.purgeConnectionIngestedFiles.mockResolvedValue({ remaining: false });
    h.deleteInstallation.mockResolvedValue(undefined);
    h.ghConnRelease.mockResolvedValue(true);
    h.sendToQueue.mockResolvedValue(undefined);
  });

  it('is a no-op when the connection is already gone (idempotent for a duplicate webhook delivery)', async () => {
    h.ghConnFindById.mockResolvedValue(null);
    await expect(
      revokeGitHubLakeConnection({ connectionId: 'conn1', installationId: 42 }, logger)
    ).resolves.toBeUndefined();
    expect(h.dlFindById).not.toHaveBeenCalled();
    expect(h.ghConnDisableIfNoLiveSyncClaim).not.toHaveBeenCalled();
    expect(h.ghConnRelease).not.toHaveBeenCalled();
  });

  it('does not uninstall a revoke retry when the released connection s installation still has another binding', async () => {
    h.ghConnFindById.mockResolvedValue(null);
    h.ghConnFindByInstallationId.mockResolvedValue([{ id: 'other', repositoryId: 999 }]);
    await expect(
      revokeGitHubLakeConnection({ connectionId: 'conn1', installationId: 42 }, logger)
    ).resolves.toBeUndefined();
    expect(h.deleteInstallation).not.toHaveBeenCalled();
  });

  it('rethrows a failed uninstall on a connection-gone retry so SQS keeps retrying it', async () => {
    h.ghConnFindById.mockResolvedValue(null);
    h.ghConnFindByInstallationId.mockResolvedValue([]);
    h.deleteInstallation.mockRejectedValue(Object.assign(new Error('GitHub API is unavailable'), { status: 502 }));
    await expect(revokeGitHubLakeConnection({ connectionId: 'conn1', installationId: 42 }, logger)).rejects.toThrow(
      'GitHub API is unavailable'
    );
    expect(h.deleteInstallation).toHaveBeenCalledWith(CONFIG, 42);
  });

  it('only releases the connection/installation claim when its lake is already gone', async () => {
    h.dlFindById.mockResolvedValue(null);
    await revokeGitHubLakeConnection({ connectionId: 'conn1', installationId: 42 }, logger);
    expect(h.ghConnDisableIfNoLiveSyncClaim).not.toHaveBeenCalled();
    expect(h.purgeConnectionIngestedFiles).not.toHaveBeenCalled();
    expect(h.ghConnRelease).toHaveBeenCalledWith(CONNECTION.id, CONNECTION.organizationId);
  });

  it('disconnects (disable, purge, release) when the connection and its lake both still exist', async () => {
    await revokeGitHubLakeConnection({ connectionId: 'conn1', installationId: 42 }, logger);
    expect(h.ghConnDisableIfNoLiveSyncClaim).toHaveBeenCalledWith('conn1', 'orgA');
    expect(h.purgeConnectionIngestedFiles).toHaveBeenCalledWith(
      LAKE,
      expect.any(Function),
      expect.objectContaining({ connectionId: 'conn1', logger, sliceSize: REVOKE_PURGE_SLICE_SIZE })
    );
    expect(h.ghConnRelease).toHaveBeenCalledWith(CONNECTION.id, CONNECTION.organizationId);
  });

  it('re-enqueues itself and skips release when the purge reports files remaining', async () => {
    h.purgeConnectionIngestedFiles.mockResolvedValue({ remaining: true });
    await revokeGitHubLakeConnection({ connectionId: 'conn1', installationId: 42 }, logger);
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.test/githubLakeRevokeQueue', {
      connectionId: 'conn1',
      installationId: 42,
    });
    expect(h.ghConnRelease).not.toHaveBeenCalled();
    expect(h.deleteInstallation).not.toHaveBeenCalled();
  });

  it('does not re-enable the connection when the purge fails, since the App has lost access', async () => {
    h.purgeConnectionIngestedFiles.mockRejectedValue(new Error('storage blip'));
    await expect(revokeGitHubLakeConnection({ connectionId: 'conn1', installationId: 42 }, logger)).rejects.toThrow(
      'storage blip'
    );
    expect(h.purgeConnectionIngestedFiles.mock.calls[0][2].restore).toBeUndefined();
    expect(h.ghConnRelease).not.toHaveBeenCalled();
  });

  it('propagates the 409 a live sync raises, so the caller lets SQS retry the message', async () => {
    h.ghConnDisableIfNoLiveSyncClaim.mockResolvedValue(null);
    await expect(
      revokeGitHubLakeConnection({ connectionId: 'conn1', installationId: 42 }, logger)
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(h.purgeConnectionIngestedFiles).not.toHaveBeenCalled();
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

describe('GitHub connection enable helpers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('disables and re-enables the lake s binding', async () => {
    h.ghConnSetEnabledForLake.mockResolvedValue(true);
    await expect(disableGitHubConnectionForLake('lake1')).resolves.toBe(true);
    expect(h.ghConnSetEnabledForLake).toHaveBeenLastCalledWith('lake1', false);
    await expect(enableGitHubConnectionForLake('lake1')).resolves.toBe(true);
    expect(h.ghConnSetEnabledForLake).toHaveBeenLastCalledWith('lake1', true);
  });
});
