import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { OrgGoogleDriveConnection, orgGoogleDriveConnectionRepository } from './OrgGoogleDriveConnectionModel';

/**
 * Invariants for the org Google Drive connection (#1588). The load-bearing ones are the global
 * uniqueness of driveFolderId (a folder is claimable by one org, ever - the anti-cross-org-claim
 * control from the #1587 security review) and that oauthRefreshToken never leaks into a default read.
 */

let server: Awaited<ReturnType<typeof createMongoServer>>;

const base = {
  organizationId: 'org-1',
  authMode: 'oauth' as const,
  driveFolderId: 'folder-1',
  targetDataLakeId: 'lake-1',
  connectedBy: 'user-1',
};

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Build the unique indexes so the uniqueness invariants below actually fire.
  await OrgGoogleDriveConnection.syncIndexes();
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);

afterEach(async () => {
  await OrgGoogleDriveConnection.deleteMany({}, { hardDelete: true });
});

describe('OrgGoogleDriveConnectionModel - credential handling', () => {
  it('excludes oauthRefreshToken from default reads but returns it via findByIdWithCredentials', async () => {
    const created = await OrgGoogleDriveConnection.create({ ...base, oauthRefreshToken: 'enc-token' });

    const defaultRead = await OrgGoogleDriveConnection.findById(created.id);
    expect(defaultRead).not.toBeNull();
    expect(defaultRead?.oauthRefreshToken).toBeUndefined();

    const withCreds = await orgGoogleDriveConnectionRepository.findByIdWithCredentials(created.id, 'org-1');
    expect(withCreds?.oauthRefreshToken).toBe('enc-token');

    // org-scoped: another org cannot load this connection's credential by id alone.
    expect(await orgGoogleDriveConnectionRepository.findByIdWithCredentials(created.id, 'org-2')).toBeFalsy();
  });

  it('updateCredential rewrites the token, re-stamps connectedBy, heals status, and is org-scoped', async () => {
    const created = await OrgGoogleDriveConnection.create({ ...base, oauthRefreshToken: 'enc-old' });
    await orgGoogleDriveConnectionRepository.updateHealth(created.id, {
      status: 'credential_error',
      lastError: 'invalid_grant',
    });

    // Wrong org cannot overwrite this connection's credential.
    expect(
      await orgGoogleDriveConnectionRepository.updateCredential(created.id, 'org-2', 'enc-new', 'user-2')
    ).toBeFalsy();
    const stillOld = await orgGoogleDriveConnectionRepository.findByIdWithCredentials(created.id, 'org-1');
    expect(stillOld?.oauthRefreshToken).toBe('enc-old');

    // Correct org: token rewritten, connectedBy re-stamped to the re-syncer, status healed, error cleared.
    const updated = await orgGoogleDriveConnectionRepository.updateCredential(created.id, 'org-1', 'enc-new', 'user-2');
    expect(updated?.status).toBe('connected');
    expect(updated?.connectedBy).toBe('user-2');
    expect(updated?.lastError ?? null).toBeNull();
    const withCreds = await orgGoogleDriveConnectionRepository.findByIdWithCredentials(created.id, 'org-1');
    expect(withCreds?.oauthRefreshToken).toBe('enc-new');
  });

  it('updateCredential writes the credential but does NOT heal a syncing connection (no claim flip)', async () => {
    // A Re-sync issued while an ingest is in flight must not flip 'syncing' -> 'connected', or
    // claimForSync would let the re-triggered run claim on top of the live one (duplicate ingest).
    const created = await OrgGoogleDriveConnection.create({
      ...base,
      oauthRefreshToken: 'enc-old',
      status: 'syncing',
    });

    const updated = await orgGoogleDriveConnectionRepository.updateCredential(created.id, 'org-1', 'enc-new', 'user-2');

    // Credential + connectedBy are written unconditionally...
    expect(updated?.connectedBy).toBe('user-2');
    const withCreds = await orgGoogleDriveConnectionRepository.findByIdWithCredentials(created.id, 'org-1');
    expect(withCreds?.oauthRefreshToken).toBe('enc-new');
    // ...but the claim is left intact, so the second ingest defers instead of running concurrently.
    expect(updated?.status).toBe('syncing');
  });
});

describe('OrgGoogleDriveConnectionModel - uniqueness invariants', () => {
  it('rejects a second org claiming the same Drive folder (global folder uniqueness)', async () => {
    await OrgGoogleDriveConnection.create(base);
    await expect(
      OrgGoogleDriveConnection.create({
        ...base,
        organizationId: 'org-2',
        targetDataLakeId: 'lake-2', // different lake, same folder
      })
    ).rejects.toThrow();
  });

  it('rejects two connections feeding the same lake (one folder per lake)', async () => {
    await OrgGoogleDriveConnection.create(base);
    await expect(
      OrgGoogleDriveConnection.create({
        ...base,
        organizationId: 'org-2',
        driveFolderId: 'folder-2', // different folder, same lake
      })
    ).rejects.toThrow();
  });

  it('release hard-deletes so the freed folder can be re-claimed (even by another org)', async () => {
    const created = await OrgGoogleDriveConnection.create(base);

    // Wrong org cannot release it.
    expect(await orgGoogleDriveConnectionRepository.release(created.id, 'org-2')).toBe(false);
    await expect(
      OrgGoogleDriveConnection.create({ ...base, organizationId: 'org-2', targetDataLakeId: 'lake-2' })
    ).rejects.toThrow();

    // Owning org releases it; the global folder claim is freed for a fresh claim.
    expect(await orgGoogleDriveConnectionRepository.release(created.id, 'org-1')).toBe(true);
    const reclaimed = await OrgGoogleDriveConnection.create({
      ...base,
      organizationId: 'org-2',
      targetDataLakeId: 'lake-2',
    });
    expect(reclaimed.id).toBeTruthy();
  });

  it('allows one org to hold multiple connections (distinct folders + lakes)', async () => {
    await OrgGoogleDriveConnection.create(base);
    const second = await OrgGoogleDriveConnection.create({
      ...base,
      driveFolderId: 'folder-2',
      targetDataLakeId: 'lake-2',
    });
    expect(second.id).toBeTruthy();

    const all = await orgGoogleDriveConnectionRepository.findByOrganizationId('org-1');
    expect(all).toHaveLength(2);
  });
});

describe('OrgGoogleDriveConnectionModel - accessors', () => {
  it('findByOrganizationId excludes disabled; findByOrganizationIdAny includes it', async () => {
    await OrgGoogleDriveConnection.create(base);
    await OrgGoogleDriveConnection.create({
      ...base,
      driveFolderId: 'folder-2',
      targetDataLakeId: 'lake-2',
      enabled: false,
    });

    const enabledOnly = await orgGoogleDriveConnectionRepository.findByOrganizationId('org-1');
    expect(enabledOnly).toHaveLength(1);
    expect(enabledOnly[0].driveFolderId).toBe('folder-1');

    const any = await orgGoogleDriveConnectionRepository.findByOrganizationIdAny('org-1');
    expect(any).toHaveLength(2);
  });

  it('findByDataLakeId and findByDriveFolderId resolve the connection', async () => {
    const created = await OrgGoogleDriveConnection.create(base);
    expect((await orgGoogleDriveConnectionRepository.findByDataLakeId('lake-1', 'org-1'))?.id).toBe(created.id);
    expect((await orgGoogleDriveConnectionRepository.findByDriveFolderId('folder-1'))?.id).toBe(created.id);
    // org-scoped: a different org sees no connection for this lake.
    expect(await orgGoogleDriveConnectionRepository.findByDataLakeId('lake-1', 'org-2')).toBeFalsy();
  });

  it("findByConnectedBy returns the credential owner's connections across orgs", async () => {
    await OrgGoogleDriveConnection.create(base);
    await OrgGoogleDriveConnection.create({
      ...base,
      organizationId: 'org-2',
      driveFolderId: 'folder-2',
      targetDataLakeId: 'lake-2',
    });
    // A connection whose credential belongs to someone else must NOT be swept up.
    await OrgGoogleDriveConnection.create({
      ...base,
      driveFolderId: 'folder-3',
      targetDataLakeId: 'lake-3',
      connectedBy: 'user-2',
    });

    // Cross-org on purpose: revoking user-1's Google grant breaks their connections in EVERY org, so
    // an org-scoped read here would leave the others silently broken.
    const mine = await orgGoogleDriveConnectionRepository.findByConnectedBy('user-1');
    expect(mine.map(c => c.driveFolderId).sort()).toEqual(['folder-1', 'folder-2']);
    expect(await orgGoogleDriveConnectionRepository.findByConnectedBy('user-3')).toHaveLength(0);
  });

  it('findByConnectedBy excludes the credential from the returned documents', async () => {
    await OrgGoogleDriveConnection.create({ ...base, oauthRefreshToken: 'enc-token' });
    const [found] = await orgGoogleDriveConnectionRepository.findByConnectedBy('user-1');
    expect(found.oauthRefreshToken).toBeUndefined();
  });

  it('findByDataLakeId excludes a disabled connection', async () => {
    await OrgGoogleDriveConnection.create({ ...base, enabled: false });
    // BaseRepository.findOne resolves to undefined (not null) on no match - matches the sibling repos.
    expect(await orgGoogleDriveConnectionRepository.findByDataLakeId('lake-1', 'org-1')).toBeFalsy();
  });
});

describe('OrgGoogleDriveConnectionModel - health + sync cursor', () => {
  it('updateHealth sets an error and then clears it on a healthy update', async () => {
    const created = await OrgGoogleDriveConnection.create(base);

    const failed = await orgGoogleDriveConnectionRepository.updateHealth(created.id, {
      status: 'needs_reconnect',
      lastError: 'folder 404',
    });
    expect(failed?.status).toBe('needs_reconnect');
    expect(failed?.lastError).toBe('folder 404');

    const recovered = await orgGoogleDriveConnectionRepository.updateHealth(created.id, {
      status: 'connected',
      lastUsedAt: new Date(),
    });
    expect(recovered?.status).toBe('connected');
    expect(recovered?.lastError ?? null).toBeNull();
  });

  it('updateHealth redacts token-shaped fragments and truncates lastError', async () => {
    const created = await OrgGoogleDriveConnection.create(base);
    const raw = 'GET https://oauth2.googleapis.com/token?access_token=ya29.A0ARrdaM9longtokenfragmentxyz123 failed';
    const updated = await orgGoogleDriveConnectionRepository.updateHealth(created.id, {
      status: 'credential_error',
      lastError: raw,
    });
    expect(updated?.lastError).toContain('[redacted]');
    expect(updated?.lastError).not.toContain('ya29.A0ARrdaM9longtokenfragmentxyz123');
    expect((updated?.lastError || '').length).toBeLessThanOrEqual(520);
  });

  it('updateSyncCursor advances the cursor and stamps lastPolledAt', async () => {
    const created = await OrgGoogleDriveConnection.create(base);
    const when = new Date();
    const updated = await orgGoogleDriveConnectionRepository.updateSyncCursor(created.id, 'page-token-2', when);
    expect(updated?.syncCursor).toBe('page-token-2');
    expect(updated?.lastPolledAt?.getTime()).toBe(when.getTime());
  });
});

describe('OrgGoogleDriveConnectionModel - sync claim (per-connection serialization)', () => {
  it('claimForSync wins once and blocks a concurrent second claim until released', async () => {
    const created = await OrgGoogleDriveConnection.create(base);

    expect(await orgGoogleDriveConnectionRepository.claimForSync(created.id)).toBe(true);
    expect((await OrgGoogleDriveConnection.findById(created.id))?.status).toBe('syncing');

    // A second run for the same connection cannot claim while the first holds it.
    expect(await orgGoogleDriveConnectionRepository.claimForSync(created.id)).toBe(false);

    // Once released, a later run can claim again.
    await orgGoogleDriveConnectionRepository.releaseSyncClaim(created.id);
    expect((await OrgGoogleDriveConnection.findById(created.id))?.status).toBe('connected');
    expect(await orgGoogleDriveConnectionRepository.claimForSync(created.id)).toBe(true);
  });

  it('releaseSyncClaim stamps lastPolledAt so a hard-failing connection is not re-enqueued every tick', async () => {
    // A deterministic failure (unlistable subtree, Mongo timeout) heals 'syncing' -> 'connected' via
    // this release. Without stamping lastPolledAt it would stay due and be re-enqueued every hourly
    // tick, re-walking then failing each time. Stamping keeps the 6h cadence on the failure path.
    const created = await OrgGoogleDriveConnection.create(base);
    await orgGoogleDriveConnectionRepository.claimForSync(created.id);

    const before = Date.now();
    const released = await orgGoogleDriveConnectionRepository.releaseSyncClaim(created.id);
    expect(released?.status).toBe('connected');
    expect(released?.lastPolledAt?.getTime()).toBeGreaterThanOrEqual(before);

    // End-to-end: a connection just released this way is no longer due (its fresh lastPolledAt is
    // after the poll cutoff), so the scan does not re-enqueue it until the interval elapses.
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const due = await orgGoogleDriveConnectionRepository.findDueForPoll(cutoff, 10);
    expect(due.map(d => d.id)).not.toContain(created.id);
  });

  it('releaseSyncClaim records the failure on lastError so a broken connection is not silently healthy', async () => {
    // The release heals the status to 'connected' AND stamps a fresh lastPolledAt, so without this a
    // deterministically-failing connection reads healthy and recently-polled with nothing anywhere to
    // tell an operator its syncs keep dying.
    const created = await OrgGoogleDriveConnection.create(base);
    await orgGoogleDriveConnectionRepository.claimForSync(created.id);

    const released = await orgGoogleDriveConnectionRepository.releaseSyncClaim(created.id, 'Drive folder unreadable');
    expect(released?.status).toBe('connected');
    expect(released?.lastError).toContain('Drive folder unreadable');
  });

  it('releaseSyncClaim leaves a stored lastError alone when the caller supplies none', async () => {
    // Only ever WRITTEN when supplied - a caller with nothing to say must not silently clear a real
    // error, unlike updateHealth, whose contract is to set the field to exactly what it is given.
    const created = await OrgGoogleDriveConnection.create(base);
    await orgGoogleDriveConnectionRepository.updateHealth(created.id, {
      status: 'connected',
      lastError: 'earlier failure',
    });
    await orgGoogleDriveConnectionRepository.claimForSync(created.id);

    const released = await orgGoogleDriveConnectionRepository.releaseSyncClaim(created.id);
    expect(released?.lastError).toContain('earlier failure');
  });

  it('releaseSyncClaim is guarded: it never clobbers a terminal status set under the claim', async () => {
    const created = await OrgGoogleDriveConnection.create(base);
    await orgGoogleDriveConnectionRepository.claimForSync(created.id);

    // Simulate a credential failure marking the connection while a run held 'syncing'.
    await orgGoogleDriveConnectionRepository.updateHealth(created.id, { status: 'credential_error' });

    // The failure-path release must be a no-op now - status is not 'syncing' anymore.
    const released = await orgGoogleDriveConnectionRepository.releaseSyncClaim(created.id);
    expect(released).toBeNull();
    expect((await OrgGoogleDriveConnection.findById(created.id))?.status).toBe('credential_error');
  });

  it('reclaims a STALE syncing claim so a dead ingest process cannot wedge it forever', async () => {
    const created = await OrgGoogleDriveConnection.create(base);
    expect(await orgGoogleDriveConnectionRepository.claimForSync(created.id)).toBe(true);

    // A fresh claim is not reclaimable...
    expect(await orgGoogleDriveConnectionRepository.claimForSync(created.id)).toBe(false);

    // ...but once the claim ages past the stale bound (simulating a process that died without
    // releasing), the next run can reclaim it instead of the connection being stuck 'syncing'.
    await OrgGoogleDriveConnection.updateOne(
      { _id: created.id },
      { $set: { syncClaimedAt: new Date(Date.now() - 60 * 60 * 1000) } } // 1h ago >> 20min bound
    );
    expect(await orgGoogleDriveConnectionRepository.claimForSync(created.id)).toBe(true);
    expect((await OrgGoogleDriveConnection.findById(created.id))?.status).toBe('syncing');
  });

  it('hands the claim from one ingest slice to the next without passing through connected', async () => {
    // The chain invariant for a folder too large for one run: the connection must stay 'syncing' the
    // whole way, or the re-sync poll slips in between slices and starts a competing walk.
    const created = await OrgGoogleDriveConnection.create(base);
    await orgGoogleDriveConnectionRepository.claimForSync(created.id);

    const token1 = await orgGoogleDriveConnectionRepository.renewSyncClaim(created.id, 'batch-1');
    expect(token1).not.toBeNull();
    const held = await OrgGoogleDriveConnection.findById(created.id);
    expect(held?.status).toBe('syncing');
    expect(held?.activeIngestBatchId).toBe('batch-1');
    expect(held?.ingestClaimToken).toBe(token1);

    // Wrong batch id refuses outright, regardless of token.
    expect(await orgGoogleDriveConnectionRepository.adoptSyncClaim(created.id, 'other-batch', token1!)).toBeNull();
    // Right batch id but the wrong token also refuses - the token is a real second CAS field, not
    // just an audit value alongside the batch id.
    expect(await orgGoogleDriveConnectionRepository.adoptSyncClaim(created.id, 'batch-1', 'wrong-token')).toBeNull();
    // Only the chain's own next slice - presenting BOTH the recorded batch id and its token - may
    // take it over, and doing so rotates the token to a fresh value.
    const token2 = await orgGoogleDriveConnectionRepository.adoptSyncClaim(created.id, 'batch-1', token1!);
    expect(token2).not.toBeNull();
    expect(token2).not.toBe(token1);
    // A plain claim still loses to the live chain, exactly as it does to any other in-flight run.
    expect(await orgGoogleDriveConnectionRepository.claimForSync(created.id)).toBe(false);
  });

  it('consumes the token on adopt, so a redelivered duplicate of the same continuation message loses', async () => {
    // SQS is at-least-once. Two deliveries of the SAME continuation message would both match on the
    // batch id alone; the token has to be the thing that is actually CONSUMED (rotated) so only the
    // first of the two can win - otherwise both would proceed to ingest the same tail.
    const created = await OrgGoogleDriveConnection.create(base);
    await orgGoogleDriveConnectionRepository.claimForSync(created.id);
    const token = await orgGoogleDriveConnectionRepository.renewSyncClaim(created.id, 'batch-1');

    const first = await orgGoogleDriveConnectionRepository.adoptSyncClaim(created.id, 'batch-1', token!);
    expect(first).not.toBeNull();

    const secondDelivery = await orgGoogleDriveConnectionRepository.adoptSyncClaim(created.id, 'batch-1', token!);
    expect(secondDelivery).toBeNull();
  });

  it('drops the chain id and token whenever the claim is taken or released', async () => {
    // Otherwise a continuation message left over from a dead chain could adopt a claim nobody holds.
    const created = await OrgGoogleDriveConnection.create(base);
    await orgGoogleDriveConnectionRepository.claimForSync(created.id);
    await orgGoogleDriveConnectionRepository.renewSyncClaim(created.id, 'batch-1');

    await orgGoogleDriveConnectionRepository.releaseSyncClaim(created.id);
    const releasedDoc = await OrgGoogleDriveConnection.findById(created.id);
    expect(releasedDoc?.activeIngestBatchId).toBeUndefined();
    expect(releasedDoc?.ingestClaimToken).toBeUndefined();
    expect(await orgGoogleDriveConnectionRepository.adoptSyncClaim(created.id, 'batch-1', 'anything')).toBeNull();

    await orgGoogleDriveConnectionRepository.renewSyncClaim(created.id, 'batch-2'); // no-op: not syncing
    await orgGoogleDriveConnectionRepository.claimForSync(created.id);
    const freshDoc = await OrgGoogleDriveConnection.findById(created.id);
    expect(freshDoc?.activeIngestBatchId).toBeUndefined();
    expect(freshDoc?.ingestClaimToken).toBeUndefined();
  });

  it('holds a CHAINED claim past the unchained stale bound, but still reclaims an abandoned chain', async () => {
    // A continuation is refreshed only at slice boundaries, so its un-refreshed interval is the
    // message's queue wait, not its run length. Reclaiming at the unchained bound would hand the
    // connection to a fresh poll that has no resumeBatchId, and it would re-ingest the still-`pending`
    // tail as new ADDs - the duplicate spiral chaining exists to prevent.
    const created = await OrgGoogleDriveConnection.create(base);
    await orgGoogleDriveConnectionRepository.claimForSync(created.id);
    const token = await orgGoogleDriveConnectionRepository.renewSyncClaim(created.id, 'batch-1');

    await OrgGoogleDriveConnection.updateOne(
      { _id: created.id },
      { $set: { syncClaimedAt: new Date(Date.now() - 30 * 60 * 1000) } } // past 20min, inside 60min
    );
    expect(await orgGoogleDriveConnectionRepository.claimForSync(created.id)).toBe(false);
    expect(await orgGoogleDriveConnectionRepository.adoptSyncClaim(created.id, 'batch-1', token!)).not.toBeNull();

    // Finite, though: a chain that really is dead must not wedge the connection forever.
    await OrgGoogleDriveConnection.updateOne(
      { _id: created.id },
      { $set: { syncClaimedAt: new Date(Date.now() - 90 * 60 * 1000) } }
    );
    expect(await orgGoogleDriveConnectionRepository.claimForSync(created.id)).toBe(true);
    expect((await OrgGoogleDriveConnection.findById(created.id))?.activeIngestBatchId).toBeUndefined();
  });

  it('renewSyncClaim will not re-point a batch that belongs to another chain', async () => {
    // A slow slice renewing after its claim was reclaimed and re-chained must lose, not stamp its own
    // dead batch over the live one.
    const created = await OrgGoogleDriveConnection.create(base);
    await orgGoogleDriveConnectionRepository.claimForSync(created.id);
    await orgGoogleDriveConnectionRepository.renewSyncClaim(created.id, 'batch-live');

    expect(await orgGoogleDriveConnectionRepository.renewSyncClaim(created.id, 'batch-dead')).toBeNull();
    expect((await OrgGoogleDriveConnection.findById(created.id))?.activeIngestBatchId).toBe('batch-live');
    expect(await orgGoogleDriveConnectionRepository.renewSyncClaim(created.id, 'batch-live')).not.toBeNull();
  });

  it('adoptSyncClaim refuses a connection that is not syncing at all', async () => {
    const created = await OrgGoogleDriveConnection.create(base);
    expect(await orgGoogleDriveConnectionRepository.adoptSyncClaim(created.id, 'batch-1', 'any-token')).toBeNull();
    expect((await OrgGoogleDriveConnection.findById(created.id))?.status).toBe('connected');
  });

  it('does not claim OVER an error state (credential_error / needs_reconnect)', async () => {
    const created = await OrgGoogleDriveConnection.create(base);
    await orgGoogleDriveConnectionRepository.updateHealth(created.id, { status: 'credential_error' });

    // Claiming a broken connection would let a later release flip it to 'connected' and erase the
    // real error. The claim must refuse, leaving the error state intact.
    expect(await orgGoogleDriveConnectionRepository.claimForSync(created.id)).toBe(false);
    expect((await OrgGoogleDriveConnection.findById(created.id))?.status).toBe('credential_error');
  });
});

describe('OrgGoogleDriveConnectionModel - findDueForPoll (re-sync scan)', () => {
  const anHourAgo = () => new Date(Date.now() - 60 * 60 * 1000);

  it('returns never-polled and stale-polled connections, oldest-first, and honors the cap', async () => {
    // never polled
    const a = await OrgGoogleDriveConnection.create({ ...base, driveFolderId: 'f-a', targetDataLakeId: 'l-a' });
    // polled long ago (stale)
    const b = await OrgGoogleDriveConnection.create({
      ...base,
      driveFolderId: 'f-b',
      targetDataLakeId: 'l-b',
      lastPolledAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    // polled just now (fresh) - must be excluded
    await OrgGoogleDriveConnection.create({
      ...base,
      driveFolderId: 'f-c',
      targetDataLakeId: 'l-c',
      lastPolledAt: new Date(),
    });

    const due = await orgGoogleDriveConnectionRepository.findDueForPoll(anHourAgo(), 10);
    const ids = due.map(d => d.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    // oldest-first: the never-polled (null sorts first) leads the stale one.
    expect(ids[0]).toBe(a.id);

    const capped = await orgGoogleDriveConnectionRepository.findDueForPoll(anHourAgo(), 1);
    expect(capped).toHaveLength(1);
    expect(capped[0].id).toBe(a.id);
  });

  it('excludes disabled connections and any not in a healthy connected state', async () => {
    await OrgGoogleDriveConnection.create({
      ...base,
      driveFolderId: 'f-disabled',
      targetDataLakeId: 'l-disabled',
      enabled: false,
    });
    await OrgGoogleDriveConnection.create({
      ...base,
      driveFolderId: 'f-syncing',
      targetDataLakeId: 'l-syncing',
      status: 'syncing',
    });
    await OrgGoogleDriveConnection.create({
      ...base,
      driveFolderId: 'f-error',
      targetDataLakeId: 'l-error',
      status: 'credential_error',
    });
    const healthy = await OrgGoogleDriveConnection.create({
      ...base,
      driveFolderId: 'f-ok',
      targetDataLakeId: 'l-ok',
      status: 'connected',
    });

    const due = await orgGoogleDriveConnectionRepository.findDueForPoll(anHourAgo(), 10);
    expect(due.map(d => d.id)).toEqual([healthy.id]);
  });
});
