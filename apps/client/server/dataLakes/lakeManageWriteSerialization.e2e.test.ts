import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { AccessContext } from '@bike4mind/common';
// createMongoReplSet is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
import {
  User,
  DataLakeModel,
  DataLakeAccessGrantModel,
  LakeConfigChangeEventModel,
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  userRepository,
  lakeConfigChangeEventRepository,
  withTransaction,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Proves a curator's in-flight manage write cannot commit against a grant snapshot that a
 * concurrent revoke has already superseded (see the SERIALIZATION note on `grantLakeAccess`).
 *
 * Each race case pauses the manage write right after its gate read the grants, commits a revoke of
 * the curator, then lets the write continue. Both sides write the lake document inside a transaction,
 * so Mongo aborts the manage write and the retry must refuse the curator. Ordering is by latch,
 * never by timing. Each case wraps the service itself, so this proves the collision, not the route
 * wiring - that each route puts its gate and write inside `withTransaction` is pinned by the mocked
 * enter/exit tests in the route suites. Needs a real replica set (a standalone mongod rejects writes in a session), and
 * consumes the built dist, so `pnpm turbo:core:build` must be current.
 */

let replSet: MongoMemoryReplSet;

const MODELS = [User, DataLakeModel, DataLakeAccessGrantModel, LakeConfigChangeEventModel] as const;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  // No background index builds: they contend with the transactions this suite holds open on a latch.
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  // Collections exist before any test, and are emptied rather than dropped between
  // them. Otherwise the audit collection is first created while a transaction
  // is paused open, which contends with it; `recordLakeConfigChange` swallows the resulting failure,
  // so the driver retries the revoke until the paused transaction expires. Production collections
  // always exist, so that is collection setup being measured, not the collision under test.
  await Promise.all(MODELS.map(m => m.init()));
});
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
afterEach(async () => {
  await Promise.all(MODELS.map(m => (m as typeof User).deleteMany({})));
});

const suffix = () => Math.random().toString(36).slice(2, 10);

const ctxFor = (userId: string): AccessContext => ({
  userId,
  isAdmin: false,
  organizationIds: [],
  administeredOrgIds: [],
  userTags: [],
  entitlementKeys: [],
});

const createUser = (name: string, s: string) =>
  User.create({
    name,
    username: `${name}-${s}`,
    email: `${name}-${s}@example.com`,
    password: null,
    hasUsablePassword: false,
  });

const seed = async (status: 'draft' | 'active' | 'deleted') => {
  const s = suffix();
  const [owner, curator] = await Promise.all(['owner', 'curator'].map(name => createUser(name, s)));
  const lake = await dataLakeRepository.create({
    name: `Lake ${s}`,
    slug: `lake-${s}`,
    fileTagPrefix: `lake-${s}:`,
    datalakeTag: `lake-${s}`,
    createdByUserId: owner.id,
    isPublic: false,
    status,
  } as never);
  await dataLakeAccessGrantRepository.upsertGrant({
    dataLakeId: lake.id,
    principalType: 'user',
    principalId: curator.id,
    role: 'curator',
    grantedByUserId: owner.id,
  });
  return { owner, curator, lake, s };
};

/**
 * A grant repo whose first `listByLake` pauses AFTER reading until `release()`, so a revoke can
 * commit between the manage write's gate read and its write.
 */
const pausingGrants = () => {
  let release!: () => void;
  const released = new Promise<void>(r => (release = r));
  let reachedGate!: () => void;
  const atGate = new Promise<void>(r => (reachedGate = r));
  let calls = 0;
  const repo = new Proxy(dataLakeAccessGrantRepository, {
    get(target, prop, receiver) {
      if (prop !== 'listByLake') return Reflect.get(target, prop, receiver);
      return async (...args: Parameters<typeof target.listByLake>) => {
        const rows = await target.listByLake(...args);
        if (++calls === 1) {
          reachedGate();
          await released;
        }
        return rows;
      };
    },
  });
  return { repo, atGate, release };
};

const revokeAsOwner = (owner: { id: string }, lakeId: string, curatorId: string): Promise<{ revoked: boolean }> =>
  withTransaction(async () => {
    const { lake, grants } = await dataLakeService.assertLakeAccessWithGrants(lakeId, ctxFor(owner.id), {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    return dataLakeService.revokeLakeAccess(
      ctxFor(owner.id),
      lake,
      grants,
      { principalType: 'user', principalId: curatorId },
      {
        db: {
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: dataLakeAccessGrantRepository,
          users: userRepository,
          lakeConfigChangeEvents: lakeConfigChangeEventRepository,
        },
      }
    );
  });

describe('lake manage writes vs a concurrent grant revoke (replica set)', () => {
  it('aborts a curator promote whose grant was revoked mid-request, and the retry refuses it', async () => {
    const { owner, curator, lake } = await seed('draft');
    const { repo, atGate, release } = pausingGrants();
    let attempts = 0;

    const promote = withTransaction(async () => {
      attempts++;
      return dataLakeService.promoteDataLake(ctxFor(curator.id), lake.id, {
        db: {
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: repo,
          lakeConfigChangeEvents: lakeConfigChangeEventRepository,
        },
      });
    });
    // Attached now so the rejection is never unhandled while the revoke runs.
    const outcome = promote.then(
      () => null,
      (e: unknown) => e
    );

    await atGate;
    // Committed BEFORE the latch opens: released first, the promote's write would win and the
    // revoke would be the one to retry.
    await expect(revokeAsOwner(owner, lake.id, curator.id)).resolves.toEqual({ revoked: true });
    release();

    expect(String(await outcome)).toMatch(/You do not have permission to promote this data lake/);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect((await dataLakeRepository.findById(lake.id))?.status).toBe('draft');
    expect(await dataLakeAccessGrantRepository.findGrant(lake.id, 'user', curator.id)).toBeNull();
  });

  it('aborts a curator metadata PUT whose grant was revoked mid-request, and the retry refuses it', async () => {
    const { owner, curator, lake } = await seed('active');
    const { repo, atGate, release } = pausingGrants();
    let attempts = 0;

    const update = withTransaction(async () => {
      attempts++;
      return dataLakeService.updateDataLake(
        ctxFor(curator.id),
        lake.id,
        { description: 'edited by a revoked curator' },
        {
          db: {
            dataLakes: dataLakeRepository,
            dataLakeAccessGrants: repo,
            lakeConfigChangeEvents: lakeConfigChangeEventRepository,
          },
        }
      );
    });
    const outcome = update.then(
      () => null,
      (e: unknown) => e
    );

    await atGate;
    await expect(revokeAsOwner(owner, lake.id, curator.id)).resolves.toEqual({ revoked: true });
    release();

    expect(String(await outcome)).toMatch(/You do not have permission to update this data lake/);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect((await dataLakeRepository.findById(lake.id))?.description).toBeUndefined();
  });

  it('aborts a curator cleanup claim whose grant was revoked mid-request, leaving the lake deleted', async () => {
    const { owner, curator, lake } = await seed('deleted');
    const { repo, atGate, release } = pausingGrants();
    let attempts = 0;

    const purge = withTransaction(async () => {
      attempts++;
      return dataLakeService.acceptDataLakePurge(ctxFor(curator.id), lake.id, 'claim-1', {
        db: {
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: repo,
          lakeConfigChangeEvents: lakeConfigChangeEventRepository,
        },
      });
    });
    const outcome = purge.then(
      () => null,
      (e: unknown) => e
    );

    await atGate;
    await expect(revokeAsOwner(owner, lake.id, curator.id)).resolves.toEqual({ revoked: true });
    release();

    expect(String(await outcome)).toMatch(/You do not have permission to clean up this data lake/);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect((await dataLakeRepository.findById(lake.id))?.status).toBe('deleted');
  });

  it('aborts a curator grant whose own grant was revoked mid-request, leaving no row for the grantee', async () => {
    const { owner, curator, lake, s } = await seed('active');
    const reader = await createUser('reader', s);
    const { repo, atGate, release } = pausingGrants();
    let attempts = 0;

    // Shaped like the grants route: the access gate runs INSIDE the callback so a retry re-reads.
    const grant = withTransaction(async () => {
      attempts++;
      const { lake: resolved, grants } = await dataLakeService.assertLakeAccessWithGrants(lake.id, ctxFor(curator.id), {
        db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: repo },
      });
      return dataLakeService.grantLakeAccess(
        ctxFor(curator.id),
        resolved,
        grants,
        { principalType: 'user', principalEmail: reader.email!, role: 'reader' },
        {
          db: {
            dataLakes: dataLakeRepository,
            dataLakeAccessGrants: dataLakeAccessGrantRepository,
            users: userRepository,
            lakeConfigChangeEvents: lakeConfigChangeEventRepository,
          },
        }
      );
    });
    const outcome = grant.then(
      () => null,
      (e: unknown) => e
    );

    await atGate;
    await expect(revokeAsOwner(owner, lake.id, curator.id)).resolves.toEqual({ revoked: true });
    release();

    // Once the curator holds nothing, the private lake is invisible to them: the access gate's
    // not-found-style denial, not the manage gate's Forbidden.
    expect(String(await outcome)).toMatch(/Data lake not found/);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(await dataLakeAccessGrantRepository.findGrant(lake.id, 'user', reader.id)).toBeNull();
    expect(await dataLakeAccessGrantRepository.findGrant(lake.id, 'user', curator.id)).toBeNull();
  });

  // The collision needs the stamp to be a REAL write even when `lastUpdatedByUserId` already names
  // the actor (an owner revoking twice in a row). It is, because `timestamps: true` moves updatedAt.
  it('a same-value stamp still changes the lake document', async () => {
    const { owner, lake } = await seed('active');
    await dataLakeRepository.update({ id: lake.id, lastUpdatedByUserId: owner.id });
    // Backdated without touching the timestamp plugin, so the comparison needs no real wait.
    const before = new Date(0);
    await DataLakeModel.updateOne({ _id: lake.id }, { $set: { updatedAt: before } }, { timestamps: false });

    await dataLakeRepository.update({ id: lake.id, lastUpdatedByUserId: owner.id });

    const after = (await dataLakeRepository.findById(lake.id))!.updatedAt;
    expect(new Date(after!).getTime()).toBeGreaterThan(before.getTime());
  });
});
