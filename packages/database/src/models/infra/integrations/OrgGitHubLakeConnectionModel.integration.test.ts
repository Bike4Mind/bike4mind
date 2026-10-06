import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import {
  OrgGitHubLakeConnection,
  orgGitHubLakeConnectionRepository,
  isGitHubLakeSyncClaimLive,
} from './OrgGitHubLakeConnectionModel';

/**
 * Invariants for the one-repo-to-one-lake GitHub connection: the global uniqueness of both
 * repositoryId (a repo feeds one lake, ever) and targetDataLakeId (a lake is fed by one source),
 * that several bindings may legitimately share an installationId, and that release is org-scoped
 * and hard-deletes so the freed claims can be re-taken.
 */

let server: Awaited<ReturnType<typeof createMongoServer>>;

const base = {
  organizationId: 'org-1',
  targetDataLakeId: 'lake-1',
  installationId: 111,
  accountLogin: 'acme',
  repositoryId: 1,
  repositoryFullName: 'acme/one',
  connectedBy: 'user-1',
  connectedAt: new Date('2024-01-01T00:00:00.000Z'),
};

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await OrgGitHubLakeConnection.createIndexes();
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);

afterEach(async () => {
  await OrgGitHubLakeConnection.deleteMany({}, { hardDelete: true });
});

describe('OrgGitHubLakeConnectionModel - creation', () => {
  it('creates a connection', async () => {
    const created = await OrgGitHubLakeConnection.create(base);
    expect(created.id).toBeTruthy();
    expect(created.repositoryFullName).toBe('acme/one');
  });
});

describe('OrgGitHubLakeConnectionModel - uniqueness invariants', () => {
  it('rejects a second lake claiming the same repository (global repositoryId uniqueness)', async () => {
    await OrgGitHubLakeConnection.create(base);
    await expect(
      OrgGitHubLakeConnection.create({
        ...base,
        targetDataLakeId: 'lake-2', // different lake, same repo
      })
    ).rejects.toThrow();
  });

  it('rejects a second repository feeding the same lake (one source per lake)', async () => {
    await OrgGitHubLakeConnection.create(base);
    await expect(
      OrgGitHubLakeConnection.create({
        ...base,
        repositoryId: 2, // different repo, same lake
      })
    ).rejects.toThrow();
  });

  it('allows two repositories under the same installation, and findByInstallationId returns both', async () => {
    const first = await OrgGitHubLakeConnection.create(base);
    const second = await OrgGitHubLakeConnection.create({
      ...base,
      targetDataLakeId: 'lake-2',
      repositoryId: 2,
      repositoryFullName: 'acme/two',
    });

    const bound = await orgGitHubLakeConnectionRepository.findByInstallationId(base.installationId);
    expect(bound.map(b => b.id).sort()).toEqual([first.id, second.id].sort());
  });
});

describe('OrgGitHubLakeConnectionModel - accessors', () => {
  it('findByDataLakeIdAny resolves the connection feeding a lake, or undefined for none', async () => {
    const created = await OrgGitHubLakeConnection.create(base);
    expect((await orgGitHubLakeConnectionRepository.findByDataLakeIdAny('lake-1'))?.id).toBe(created.id);
    expect(await orgGitHubLakeConnectionRepository.findByDataLakeIdAny('lake-missing')).toBeFalsy();
  });

  it('findByRepositoryIds resolves every connection binding any of the given repository ids, across orgs', async () => {
    const first = await OrgGitHubLakeConnection.create(base);
    const second = await OrgGitHubLakeConnection.create({
      ...base,
      organizationId: 'org-2',
      targetDataLakeId: 'lake-2',
      installationId: 222,
      repositoryId: 2,
      repositoryFullName: 'acme/two',
    });

    const found = await orgGitHubLakeConnectionRepository.findByRepositoryIds([1, 2, 999]);
    expect(found.map(c => c.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('findByRepositoryIds returns an empty array for an empty input, without querying', async () => {
    await OrgGitHubLakeConnection.create(base);
    expect(await orgGitHubLakeConnectionRepository.findByRepositoryIds([])).toEqual([]);
  });

  it('findByRepositoryIds returns an empty array when none of the ids bind a lake', async () => {
    await OrgGitHubLakeConnection.create(base);
    expect(await orgGitHubLakeConnectionRepository.findByRepositoryIds([999])).toEqual([]);
  });
});

describe('OrgGitHubLakeConnectionModel - findBoundDataLakeIds', () => {
  it('returns the given lakes that have a row, disabled rows included, like findByDataLakeIdAny', async () => {
    await OrgGitHubLakeConnection.create(base);
    await OrgGitHubLakeConnection.create({ ...base, targetDataLakeId: 'lake-2', repositoryId: 2, enabled: false });
    await OrgGitHubLakeConnection.create({ ...base, targetDataLakeId: 'lake-other', repositoryId: 3 });

    const bound = await orgGitHubLakeConnectionRepository.findBoundDataLakeIds(['lake-1', 'lake-2', 'lake-3']);
    expect(bound.sort()).toEqual(['lake-1', 'lake-2']);
  });

  it('returns an empty array for an empty input', async () => {
    await OrgGitHubLakeConnection.create(base);
    expect(await orgGitHubLakeConnectionRepository.findBoundDataLakeIds([])).toEqual([]);
  });
});

describe('OrgGitHubLakeConnectionModel - release', () => {
  it('is org-scoped: the wrong org cannot release, and the row is kept', async () => {
    const created = await OrgGitHubLakeConnection.create(base);
    expect(await orgGitHubLakeConnectionRepository.release(created.id, 'org-2')).toBe(false);
    expect(await OrgGitHubLakeConnection.findById(created.id)).not.toBeNull();
  });

  it('hard-deletes so a released repository can be re-claimed', async () => {
    const created = await OrgGitHubLakeConnection.create(base);
    expect(await orgGitHubLakeConnectionRepository.release(created.id, 'org-1')).toBe(true);
    expect(await OrgGitHubLakeConnection.findById(created.id)).toBeNull();

    const reclaimed = await OrgGitHubLakeConnection.create({
      ...base,
      organizationId: 'org-2',
      targetDataLakeId: 'lake-2',
    });
    expect(reclaimed.id).toBeTruthy();
  });
});

const repo = orgGitHubLakeConnectionRepository;
const ageClaim = (id: string, minutes: number) =>
  OrgGitHubLakeConnection.updateOne({ _id: id }, { $set: { syncClaimedAt: new Date(Date.now() - minutes * 60_000) } });

describe('OrgGitHubLakeConnectionModel - sync claim', () => {
  it('defaults a new binding to enabled and connected', async () => {
    const { id } = await repo.create(base);
    expect(await repo.findById(id)).toMatchObject({ enabled: true, status: 'connected' });
  });

  it('lets exactly one of two concurrent claims win', async () => {
    const { id } = await repo.create(base);
    const tokens = await Promise.all([repo.claimForSync(id), repo.claimForSync(id)]);
    expect(tokens.filter(Boolean)).toHaveLength(1);
  });

  it('claims a binding written before the sync fields existed', async () => {
    const { insertedId } = await OrgGitHubLakeConnection.collection.insertOne({
      ...base,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(await repo.claimForSync(insertedId.toString())).toEqual(expect.any(String));
  });

  it('reclaims an unchained claim only once it is stale', async () => {
    const { id } = await repo.create(base);
    expect(await repo.claimForSync(id)).toBeTruthy();
    expect(await repo.claimForSync(id)).toBeNull();
    await ageClaim(id, 21);
    expect(await repo.claimForSync(id)).toBeTruthy();
  });

  it('holds a chained claim past the unchained staleness window', async () => {
    const { id } = await repo.create(base);
    const token = await repo.claimForSync(id);
    expect(await repo.renewSyncClaim(id, 'batch-1', token!)).toBeTruthy();
    await ageClaim(id, 21);
    expect(await repo.claimForSync(id)).toBeNull();
    await ageClaim(id, 61);
    expect(await repo.claimForSync(id)).toBeTruthy();
  });

  it('hands a chain from slice to slice and refuses a replayed token', async () => {
    const { id } = await repo.create(base);
    const claimed = await repo.claimForSync(id);
    const renewed = await repo.renewSyncClaim(id, 'batch-1', claimed!);
    const adopted = await repo.adoptSyncClaim(id, 'batch-1', renewed!);
    expect(adopted).toEqual({ token: expect.any(String), enabled: true });
    expect(await repo.adoptSyncClaim(id, 'batch-1', renewed!)).toBeNull();
    expect(await repo.renewSyncClaim(id, 'batch-1', renewed!)).toBeNull();
    expect(await repo.renewSyncClaim(id, 'batch-1', adopted!.token)).toBeTruthy();
  });

  it('release heals to connected, redacts lastError, and ends the chain', async () => {
    const { id } = await repo.create(base);
    const token = await repo.claimForSync(id);
    const renewed = await repo.renewSyncClaim(id, 'batch-1', token!);
    const tokenLike = 'x'.repeat(40);
    expect(await repo.releaseSyncClaim(id, renewed!, `boom ${tokenLike}`)).not.toBeNull();
    const after = await repo.findById(id);
    expect(after).toMatchObject({ status: 'connected', lastError: 'boom [redacted]' });
    expect(after?.activeIngestBatchId).toBeUndefined();
    expect(after?.ingestClaimToken).toBeUndefined();
    expect(await repo.adoptSyncClaim(id, 'batch-1', renewed!)).toBeNull();
  });

  it('release can park the connection in error, and a later claim may retry it', async () => {
    const { id } = await repo.create(base);
    const token = await repo.claimForSync(id);
    await repo.releaseSyncClaim(id, token!, 'reconnect', 'error');
    expect(await repo.findById(id)).toMatchObject({ status: 'error', lastError: 'reconnect' });
    expect(await repo.claimForSync(id)).toBeTruthy();
  });

  it('release by a superseded token leaves the new owner alone', async () => {
    const { id } = await repo.create(base);
    const stale = await repo.claimForSync(id);
    await ageClaim(id, 21);
    const fresh = await repo.claimForSync(id);
    expect(await repo.releaseSyncClaim(id, stale!, null)).toBeNull();
    expect(await repo.findById(id)).toMatchObject({ status: 'syncing', ingestClaimToken: fresh });
  });

  it('recordSynced stamps the commit and branch, clears lastError, and ends the claim', async () => {
    const { id } = await repo.create(base);
    const failed = await repo.claimForSync(id);
    await repo.releaseSyncClaim(id, failed!, 'earlier failure');
    const token = await repo.claimForSync(id);
    expect(await repo.recordSynced(id, token!, { commitSha: 'abc123', defaultBranch: 'main' })).not.toBeNull();
    const after = await repo.findById(id);
    expect(after).toMatchObject({
      status: 'connected',
      lastError: null,
      lastSyncedCommitSha: 'abc123',
      defaultBranch: 'main',
    });
    expect(after?.lastSyncedAt).toBeInstanceOf(Date);
    expect(after?.ingestClaimToken).toBeUndefined();
  });
});

describe('OrgGitHubLakeConnectionModel - disconnect compare-and-set', () => {
  it('disables an idle connection, after which claimForSync refuses it', async () => {
    const { id } = await repo.create(base);
    expect(await repo.disableIfNoLiveSyncClaim(id, 'org-1')).toEqual({ wasEnabled: true });
    expect(await repo.findById(id)).toMatchObject({ enabled: false });
    expect(await repo.claimForSync(id)).toBeNull();
  });

  it('matches a retry on an already-disabled row and reports it was not enabled', async () => {
    const { id } = await repo.create(base);
    await repo.setEnabledForLake('lake-1', false);
    expect(await repo.disableIfNoLiveSyncClaim(id, 'org-1')).toEqual({ wasEnabled: false });
    expect(await repo.disableIfNoLiveSyncClaim(id, 'org-1')).toEqual({ wasEnabled: false });
  });

  it('disables an unchained claim once it passes the unchained staleness window', async () => {
    const { id } = await repo.create(base);
    await repo.claimForSync(id);
    await ageClaim(id, 21);
    expect(await repo.disableIfNoLiveSyncClaim(id, 'org-1')).toEqual({ wasEnabled: true });
  });

  it('lets a continuation adopt a disabled chain only to end it: adopt reports disabled, renew refuses', async () => {
    const { id } = await repo.create(base);
    const claimed = await repo.claimForSync(id);
    const renewed = await repo.renewSyncClaim(id, 'batch-1', claimed!);
    await repo.setEnabledForLake('lake-1', false);
    const adopted = await repo.adoptSyncClaim(id, 'batch-1', renewed!);
    expect(adopted).toEqual({ token: expect.any(String), enabled: false });
    expect(await repo.renewSyncClaim(id, 'batch-1', adopted!.token)).toBeNull();
    // The adopted claim is live, so a disconnect waits for the continuation to release it.
    expect(await repo.disableIfNoLiveSyncClaim(id, 'org-1')).toBeNull();
    expect(await repo.releaseSyncClaim(id, adopted!.token, null)).not.toBeNull();
    expect(await repo.disableIfNoLiveSyncClaim(id, 'org-1')).toEqual({ wasEnabled: false });
  });

  it('refuses while a claim is live and disables once it goes stale', async () => {
    const { id } = await repo.create(base);
    const token = await repo.claimForSync(id);
    expect(await repo.disableIfNoLiveSyncClaim(id, 'org-1')).toBeNull();
    await repo.renewSyncClaim(id, 'batch-1', token!);
    await ageClaim(id, 21);
    expect(await repo.disableIfNoLiveSyncClaim(id, 'org-1')).toBeNull();
    await ageClaim(id, 61);
    expect(await repo.disableIfNoLiveSyncClaim(id, 'org-1')).toEqual({ wasEnabled: true });
    expect(await repo.findById(id)).toMatchObject({ enabled: false });
  });

  it('lets exactly one of a racing claim and disable win', async () => {
    const { id } = await repo.create(base);
    const [token, disabled] = await Promise.all([repo.claimForSync(id), repo.disableIfNoLiveSyncClaim(id, 'org-1')]);
    expect(Boolean(token) !== Boolean(disabled)).toBe(true);
  });

  it('is org-scoped', async () => {
    const { id } = await repo.create(base);
    expect(await repo.disableIfNoLiveSyncClaim(id, 'org-2')).toBeNull();
    expect(await repo.findById(id)).toMatchObject({ enabled: true });
  });
});

describe('OrgGitHubLakeConnectionModel - setEnabledForLake', () => {
  it('toggles enabled on the lake s binding and reports whether one existed', async () => {
    await repo.create(base);
    expect(await repo.setEnabledForLake('lake-1', false)).toBe(true);
    expect(await repo.findByDataLakeIdAny('lake-1')).toMatchObject({ enabled: false });
    expect(await repo.setEnabledForLake('lake-1', true)).toBe(true);
    expect(await repo.findByDataLakeIdAny('lake-1')).toMatchObject({ enabled: true });
    expect(await repo.setEnabledForLake('no-such-lake', false)).toBe(false);
  });

  it('leaves a disconnecting row disabled: true is refused, false still disables', async () => {
    const { id } = await repo.create(base);
    await repo.markDisconnecting(id, 'org-1');
    expect(await repo.setEnabledForLake('lake-1', true)).toBe(false);
    expect(await repo.findByDataLakeIdAny('lake-1')).toMatchObject({ enabled: false });
    expect(await repo.setEnabledForLake('lake-1', false)).toBe(true);
    expect(await repo.findByDataLakeIdAny('lake-1')).toMatchObject({ enabled: false });
  });
});

describe('OrgGitHubLakeConnectionModel - disconnect lifecycle', () => {
  const ageDisconnect = (id: string, minutes: number) =>
    OrgGitHubLakeConnection.updateOne(
      { _id: id },
      { $set: { disconnectRequestedAt: new Date(Date.now() - minutes * 60_000) } }
    );

  it('stamps disconnectRequestedAt and disables an idle connection, reporting it was created', async () => {
    const { id } = await repo.create(base);
    const marked = await repo.markDisconnecting(id, 'org-1');
    expect(marked).toMatchObject({ created: true, previousEnabled: true });
    expect(marked?.stamp).toBeInstanceOf(Date);
    expect(await repo.findById(id)).toMatchObject({ enabled: false, disconnectRequestedAt: marked?.stamp });
  });

  it('reports created false and the already-disabled previousEnabled on a re-stamp', async () => {
    const { id } = await repo.create(base);
    const first = await repo.markDisconnecting(id, 'org-1');
    await ageDisconnect(id, 30);
    const second = await repo.markDisconnecting(id, 'org-1');
    expect(first?.created).toBe(true);
    expect(second).toMatchObject({ created: false, previousEnabled: false });
    expect(second?.stamp.getTime()).toBeGreaterThanOrEqual(first!.stamp.getTime());
  });

  it('refuses a second mark while the first disconnect is fresh', async () => {
    const { id } = await repo.create(base);
    const first = await repo.markDisconnecting(id, 'org-1');
    expect(await repo.markDisconnecting(id, 'org-1')).toBeNull();
    expect(await repo.findById(id)).toMatchObject({ disconnectRequestedAt: first!.stamp, enabled: false });
  });

  it('refuses while a sync claim is live', async () => {
    const { id } = await repo.create(base);
    await repo.claimForSync(id);
    expect(await repo.markDisconnecting(id, 'org-1')).toBeNull();
    expect(await repo.findById(id)).toMatchObject({ enabled: true });
  });

  it('is org-scoped', async () => {
    const { id } = await repo.create(base);
    expect(await repo.markDisconnecting(id, 'org-2')).toBeNull();
    expect(await repo.findById(id)).toMatchObject({ enabled: true });
  });

  it('cancelDisconnect restores enabled and clears the stamp when the stamp matches', async () => {
    const { id } = await repo.create(base);
    const marked = await repo.markDisconnecting(id, 'org-1');
    expect(await repo.cancelDisconnect(id, 'org-1', marked!.stamp, marked!.previousEnabled)).toBe(true);
    const after = await repo.findById(id);
    expect(after).toMatchObject({ enabled: true });
    expect(after?.disconnectRequestedAt).toBeUndefined();
  });

  it('cancelDisconnect is a no-op against a different stamp', async () => {
    const { id } = await repo.create(base);
    const marked = await repo.markDisconnecting(id, 'org-1');
    const otherStamp = new Date(marked!.stamp.getTime() - 1000);
    expect(await repo.cancelDisconnect(id, 'org-1', otherStamp, true)).toBe(false);
    expect(await repo.findById(id)).toMatchObject({ enabled: false, disconnectRequestedAt: marked!.stamp });
  });

  it('touchDisconnect refreshes a pending disconnect s stamp', async () => {
    const { id } = await repo.create(base);
    await repo.markDisconnecting(id, 'org-1');
    await ageDisconnect(id, 30);
    const staleStamp = (await repo.findById(id))!.disconnectRequestedAt!;
    expect(await repo.touchDisconnect(id)).toBe(true);
    const after = await repo.findById(id);
    expect(after?.disconnectRequestedAt?.getTime()).toBeGreaterThan(staleStamp.getTime());
  });

  it('touchDisconnect reports false when no disconnect is pending', async () => {
    const { id } = await repo.create(base);
    expect(await repo.touchDisconnect(id)).toBe(false);
  });
});

describe('OrgGitHubLakeConnectionModel - recordLastError', () => {
  it('sets lastError and redacts a token-shaped value, without disturbing status', async () => {
    const { id } = await repo.create(base);
    const tokenLike = 'x'.repeat(40);
    expect(await repo.recordLastError(id, `queue failure ${tokenLike}`)).toBe(true);
    expect(await repo.findById(id)).toMatchObject({ status: 'connected', lastError: 'queue failure [redacted]' });
  });

  it('reports false for a missing connection', async () => {
    expect(await repo.recordLastError('000000000000000000000000', 'boom')).toBe(false);
  });
});

describe('isGitHubLakeSyncClaimLive', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const minutesAgo = (m: number) => new Date(now - m * 60_000);

  it.each([
    [{ status: 'connected' as const }, false],
    [{ status: 'syncing' as const, syncClaimedAt: minutesAgo(5) }, true],
    [{ status: 'syncing' as const, syncClaimedAt: minutesAgo(21) }, false],
    [{ status: 'syncing' as const, syncClaimedAt: minutesAgo(21), activeIngestBatchId: 'b1' }, true],
    [{ status: 'syncing' as const, syncClaimedAt: minutesAgo(61), activeIngestBatchId: 'b1' }, false],
  ])('%o -> %s', (conn, live) => {
    expect(isGitHubLakeSyncClaimLive(conn, now)).toBe(live);
  });
});
