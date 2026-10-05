import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { LakeConnectorClaim, lakeConnectorClaimRepository } from './LakeConnectorClaimModel';
import { OrgGitHubLakeConnection, orgGitHubLakeConnectionRepository } from './OrgGitHubLakeConnectionModel';
import { OrgGoogleDriveConnection, orgGoogleDriveConnectionRepository } from './OrgGoogleDriveConnectionModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

const oid = () => new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);

afterEach(async () => {
  await LakeConnectorClaim.deleteMany({});
  await OrgGitHubLakeConnection.deleteMany({}, { hardDelete: true });
  await OrgGoogleDriveConnection.deleteMany({}, { hardDelete: true });
});

describe('lakeConnectorClaimRepository.tryAcquire', () => {
  it('lets exactly one of many concurrent claims on one lake win, and reports it as the holder', async () => {
    const lakeId = oid();
    const claims = Array.from({ length: 8 }, (_, i) => ({
      lakeId,
      kind: i % 2 ? ('github' as const) : ('googleDrive' as const),
      connectionId: oid(),
    }));
    const results = await Promise.all(claims.map(c => lakeConnectorClaimRepository.tryAcquire(c)));

    const winners = results.flatMap((r, i) => (r.acquired ? [claims[i]] : []));
    expect(winners).toHaveLength(1);
    for (const r of results) {
      if (!r.acquired) {
        expect(r.holder).toMatchObject({ kind: winners[0].kind, connectionId: winners[0].connectionId });
      }
    }
    expect(await LakeConnectorClaim.countDocuments({ lakeId })).toBe(1);
  });

  it('rejects a lakeId that is not an ObjectId instead of claiming it', async () => {
    await expect(
      lakeConnectorClaimRepository.tryAcquire({ lakeId: '', kind: 'github', connectionId: oid() })
    ).rejects.toThrow();
    await expect(
      lakeConnectorClaimRepository.tryAcquire({ lakeId: 'lake-1', kind: 'github', connectionId: oid() })
    ).rejects.toThrow();
    expect(await LakeConnectorClaim.countDocuments({})).toBe(0);
  });
});

describe('lakeConnectorClaimRepository.takeOver', () => {
  it('swaps a holder out once; a second taker of the same stale holder loses', async () => {
    const lakeId = oid();
    const stale = oid();
    await lakeConnectorClaimRepository.tryAcquire({ lakeId, kind: 'github', connectionId: stale });

    const first = { kind: 'googleDrive' as const, connectionId: oid() };
    const second = { kind: 'github' as const, connectionId: oid() };
    const [a, b] = await Promise.all([
      lakeConnectorClaimRepository.takeOver(lakeId, stale, first),
      lakeConnectorClaimRepository.takeOver(lakeId, stale, second),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    const winner = a ? first : second;
    expect(await LakeConnectorClaim.findOne({ lakeId }).lean()).toMatchObject(winner);
  });
});

describe('lakeConnectorClaimRepository release', () => {
  it('releases by connectionId and leaves other lakes claimed', async () => {
    const [mine, other] = [oid(), oid()];
    await lakeConnectorClaimRepository.tryAcquire({ lakeId: oid(), kind: 'github', connectionId: mine });
    await lakeConnectorClaimRepository.tryAcquire({ lakeId: oid(), kind: 'googleDrive', connectionId: other });

    expect(await lakeConnectorClaimRepository.releaseByConnectionId(mine)).toBe(true);
    expect(await lakeConnectorClaimRepository.releaseByConnectionId(mine)).toBe(false);
    expect(await LakeConnectorClaim.countDocuments({ connectionId: other })).toBe(1);
  });

  it('releases several by connectionId', async () => {
    const ids = [oid(), oid(), oid()];
    for (const connectionId of ids) {
      await lakeConnectorClaimRepository.tryAcquire({ lakeId: oid(), kind: 'googleDrive', connectionId });
    }
    expect(await lakeConnectorClaimRepository.releaseByConnectionIds(ids.slice(0, 2))).toBe(2);
    expect(await lakeConnectorClaimRepository.releaseByConnectionIds([])).toBe(0);
    expect(await LakeConnectorClaim.countDocuments({})).toBe(1);
  });
});

describe('connector release() drops the matching claim', () => {
  it('GitHub: deleting the row releases its claim; a refused release keeps it', async () => {
    const lakeId = oid();
    const conn = await orgGitHubLakeConnectionRepository.create({
      organizationId: 'org-1',
      targetDataLakeId: lakeId,
      installationId: 1,
      accountLogin: 'acme',
      repositoryId: 1,
      repositoryFullName: 'acme/one',
      connectedBy: 'user-1',
      connectedAt: new Date(),
    });
    await lakeConnectorClaimRepository.tryAcquire({ lakeId, kind: 'github', connectionId: conn.id });

    expect(await orgGitHubLakeConnectionRepository.release(conn.id, 'org-2')).toBe(false);
    expect(await LakeConnectorClaim.countDocuments({ lakeId })).toBe(1);
    expect(await orgGitHubLakeConnectionRepository.release(oid(), 'org-1')).toBe(false);
    expect(await LakeConnectorClaim.countDocuments({ lakeId })).toBe(1);

    expect(await orgGitHubLakeConnectionRepository.release(conn.id, 'org-1')).toBe(true);
    expect(await LakeConnectorClaim.countDocuments({ lakeId })).toBe(0);
  });

  it('Google Drive: deleting the row releases its claim; a refused release keeps it', async () => {
    const lakeId = oid();
    const owner = { kind: 'organization' as const, organizationId: 'org-1' };
    const conn = await orgGoogleDriveConnectionRepository.create({
      organizationId: 'org-1',
      authMode: 'oauth',
      driveFolderId: 'folder-1',
      targetDataLakeId: lakeId,
      connectedBy: 'user-1',
    });
    await lakeConnectorClaimRepository.tryAcquire({ lakeId, kind: 'googleDrive', connectionId: conn.id });

    expect(
      await orgGoogleDriveConnectionRepository.release(conn.id, { kind: 'organization', organizationId: 'org-2' })
    ).toBe(false);
    expect(await LakeConnectorClaim.countDocuments({ lakeId })).toBe(1);

    expect(await orgGoogleDriveConnectionRepository.release(conn.id, owner)).toBe(true);
    expect(await LakeConnectorClaim.countDocuments({ lakeId })).toBe(0);
  });
});
