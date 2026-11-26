import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  Artifact,
  ArtifactContent,
  ArtifactVersion,
  artifactRepository,
  artifactContentRepository,
  artifactVersionRepository,
} from '@bike4mind/database';
import { artifactService } from '@bike4mind/services';
import { UnauthorizedError } from '@bike4mind/utils';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Overlapping saves against the REAL repositories: the unit tests stub the repos, so they cannot
 * see two requests reading the same state. Run `pnpm --filter @bike4mind/services-core build`
 * first: the service comes from the built dist.
 */

const OWNER = 'concurrency-owner';
const SHAREE = 'concurrency-sharee';
const SAVES = 6;
const adapters = {
  db: {
    artifacts: artifactRepository,
    artifactContents: artifactContentRepository,
    artifactVersions: artifactVersionRepository,
  },
};

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await Promise.all([
    Artifact.deleteMany({}, { hardDelete: true }),
    ArtifactContent.deleteMany({}, { hardDelete: true }),
    ArtifactVersion.deleteMany({}, { hardDelete: true }),
  ]);
});

async function seedArtifact(withCounter: boolean, canWrite: string[] = []) {
  const created = await artifactService.create(
    OWNER,
    { type: 'code', title: 'Concurrent', content: 'seed' },
    {
      assertSourceRefsAccessible: async () => {},
      db: adapters.db,
    }
  );
  const id = created.artifact.id;
  if (withCounter) await Artifact.collection.updateOne({ id }, { $set: { lastVersionNumber: 1 } });
  if (canWrite.length) await Artifact.collection.updateOne({ id }, { $set: { 'permissions.canWrite': canWrite } });
  return id;
}

const revokeSharee = (id: string) => Artifact.collection.updateOne({ id }, { $set: { 'permissions.canWrite': [] } });

// Fulfilled saves each own exactly one row; refused saves leave none. One active row, and it is the pointer.
async function expectSettled(id: string, fulfilled: number[]) {
  const expected = [1, ...fulfilled].sort((a, b) => a - b);
  const versions = await ArtifactVersion.find({ artifactId: id }).lean();
  const contents = await ArtifactContent.find({ artifactId: id }).lean();
  expect(versions.map(v => v.version).sort((a, b) => a - b)).toEqual(expected);
  expect(contents.map(c => c.version).sort((a, b) => a - b)).toEqual(expected);

  const active = versions.filter(v => v.isActive);
  expect(active).toHaveLength(1);
  const stored = await Artifact.findOne({ id }).lean();
  expect(String(stored?.currentVersionId)).toBe(String(active[0]._id));
  expect(stored?.version).toBe(expected.at(-1));
  expect(active[0].version).toBe(expected.at(-1));
}

// Runs `saves` and counts the ones refused for lost write access; any other failure is a real error.
async function settle(saves: Promise<{ version?: { version: number } }>[]) {
  const outcomes = await Promise.allSettled(saves);
  let refused = 0;
  const fulfilled: number[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') {
      fulfilled.push(outcome.value.version!.version);
    } else {
      expect(outcome.reason).toBeInstanceOf(UnauthorizedError);
      refused++;
    }
  }
  return { fulfilled, refused };
}

async function expectConsistent(id: string, numbers: number[]) {
  const expected = Array.from({ length: SAVES }, (_, i) => i + 2);
  expect([...numbers].sort((a, b) => a - b)).toEqual(expected);

  const versions = await ArtifactVersion.find({ artifactId: id }).lean();
  const contents = await ArtifactContent.find({ artifactId: id }).lean();
  expect(versions).toHaveLength(SAVES + 1);
  expect(contents).toHaveLength(SAVES + 1);

  const active = versions.filter(v => v.isActive);
  expect(active).toHaveLength(1);
  expect(active[0].version).toBe(SAVES + 1);
  const stored = await Artifact.findOne({ id }).lean();
  expect(String(stored?.currentVersionId)).toBe(String(active[0]._id));
  expect(stored?.version).toBe(SAVES + 1);
  return contents;
}

describe('artifactService.update concurrent saves', () => {
  it.each([
    ['legacy (no counter)', false],
    ['seeded counter', true],
  ])('keeps every content save: %s', async (_label, withCounter) => {
    const id = await seedArtifact(withCounter);
    const results = await Promise.all(
      Array.from({ length: SAVES }, (_, i) => artifactService.update(OWNER, { id, content: `body-${i}` }, adapters))
    );
    const contents = await expectConsistent(
      id,
      results.map(r => r.version!.version)
    );
    results.forEach((r, i) => {
      const row = contents.find(c => c.version === r.version!.version);
      expect(row?.content).toBe(`body-${i}`);
    });
  });

  it.each([
    ['legacy (no counter)', false],
    ['seeded counter', true],
  ])('keeps every createNewVersion save: %s', async (_label, withCounter) => {
    const id = await seedArtifact(withCounter);
    const results = await Promise.all(
      Array.from({ length: SAVES }, () => artifactService.update(OWNER, { id, createNewVersion: true }, adapters))
    );
    await expectConsistent(
      id,
      results.map(r => r.version!.version)
    );
  });

  it('keeps the counter out of reads and responses', async () => {
    const id = await seedArtifact(false);
    const result = await artifactService.update(OWNER, { id, content: 'next' }, adapters);
    expect(result.artifact).not.toHaveProperty('lastVersionNumber');
    expect(await Artifact.findOne({ id }).lean()).not.toHaveProperty('lastVersionNumber');
    const raw = await Artifact.collection.findOne({ id });
    expect(raw?.lastVersionNumber).toBe(2);
  });
});

describe('artifactService.update with write access revoked mid-batch', () => {
  const ROUNDS = 8;
  const PER_ROUND = 8;
  const save = (userId: string, id: string, label: string, a = adapters) =>
    artifactService.update(userId, { id, content: label }, a);

  it('leaves one active row, the pointer, and no rows for refused saves', async () => {
    let refusedTotal = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const id = await seedArtifact(round % 2 === 0, [SHAREE]);
      const saves = Array.from({ length: PER_ROUND }, (_, i) =>
        save(i % 2 === 0 ? SHAREE : OWNER, id, `round-${round}-body-${i}`)
      );
      // Revoke at a different point of the batch each round.
      const revoke = (async () => {
        for (let tick = 0; tick < round * 3; tick++) await new Promise(resolve => setImmediate(resolve));
        await revokeSharee(id);
      })();
      const [{ fulfilled, refused }] = await Promise.all([settle(saves), revoke]);
      refusedTotal += refused;
      await expectSettled(id, fulfilled);
      await Promise.all([
        Artifact.deleteMany({}, { hardDelete: true }),
        ArtifactContent.deleteMany({}, { hardDelete: true }),
        ArtifactVersion.deleteMany({}, { hardDelete: true }),
      ]);
    }
    expect(refusedTotal).toBeGreaterThan(0);
  });

  it('rolls back a save refused after its rows were written while other saves succeed', async () => {
    const id = await seedArtifact(true, [SHAREE]);
    const revokingAdapters = {
      db: {
        ...adapters.db,
        // Revokes right before the sharee's pointer write, i.e. after its rows were inserted.
        artifacts: new Proxy(artifactRepository, {
          get(target, prop) {
            const member = Reflect.get(target, prop, target);
            if (prop !== 'updateWithWriteAccess') return typeof member === 'function' ? member.bind(target) : member;
            return async (userId: string, ...rest: unknown[]) => {
              if (userId === SHAREE) await revokeSharee(id);
              return (member as (...a: unknown[]) => Promise<unknown>).call(target, userId, ...rest);
            };
          },
        }),
      },
    };

    const { fulfilled, refused } = await settle([
      save(SHAREE, id, 'sharee-body', revokingAdapters),
      ...Array.from({ length: 4 }, (_, i) => save(OWNER, id, `owner-body-${i}`, revokingAdapters)),
    ]);

    expect(refused).toBe(1);
    expect(fulfilled).toHaveLength(4);
    await expectSettled(id, fulfilled);
    const stored = await ArtifactContent.find({ artifactId: id }).lean();
    expect(stored.map(c => c.content)).not.toContain('sharee-body');
  });
});

describe('artifact active-pointer reconciliation', () => {
  it('keeps an inactive older row retired before a delayed activation can finish', async () => {
    const id = await seedArtifact(true);
    let observedAfterStaleActivation: number[] | undefined;
    const delayedAdapters = {
      db: {
        ...adapters.db,
        artifactVersions: new Proxy(artifactVersionRepository, {
          get(target, property) {
            if (property === 'activatePointerVersion') {
              return async (artifactId: string, pointer: { id: string; version: number }) => {
                if (pointer.version === 2) {
                  await artifactService.update(OWNER, { id, content: 'higher completed' }, adapters);
                  await target.activatePointerVersion(artifactId, pointer);
                  observedAfterStaleActivation = (
                    await ArtifactVersion.find({ artifactId: id, isActive: true }).lean()
                  ).map(row => row.version);
                  return;
                }
                return target.activatePointerVersion(artifactId, pointer);
              };
            }
            const member = Reflect.get(target, property, target);
            return typeof member === 'function' ? member.bind(target) : member;
          },
        }),
      },
    };
    await artifactService.update(OWNER, { id, content: 'inactive lower row' }, delayedAdapters);
    expect(observedAfterStaleActivation).toEqual([3]);
    await expectSettled(id, [2, 3]);
    const raw = await ArtifactVersion.collection.findOne({ artifactId: id, version: 2 });
    expect(raw).toMatchObject({ superseded: true });
    for (const version of await artifactVersionRepository.findByArtifactId(id)) {
      expect(version).not.toHaveProperty('superseded');
    }
  });

  it('leaves a late inserted lower row inactive after losing the forward pointer write', async () => {
    const id = await seedArtifact(true);
    let release = () => {};
    let markPaused = () => {};
    const paused = new Promise<void>(resolve => {
      markPaused = resolve;
    });
    const resume = new Promise<void>(resolve => {
      release = resolve;
    });
    const delayedAdapters = {
      db: {
        ...adapters.db,
        artifactVersions: new Proxy(artifactVersionRepository, {
          get(target, property) {
            if (property === 'create') {
              return async (data: Parameters<typeof target.create>[0]) => {
                if (data.version === 2) {
                  markPaused();
                  await resume;
                }
                return target.create(data);
              };
            }
            const member = Reflect.get(target, property, target);
            return typeof member === 'function' ? member.bind(target) : member;
          },
        }),
      },
    };
    const lower = artifactService.update(OWNER, { id, content: 'late lower insert' }, delayedAdapters);
    try {
      await paused;
      await artifactService.update(OWNER, { id, content: 'higher completed' }, adapters);
    } finally {
      release();
    }
    const result = await lower;
    expect(result.version?.isActive).toBe(false);
    await expectSettled(id, [2, 3]);
  });

  it('cannot let a delayed reconciler change a newer completed writer after its retry budget', async () => {
    const id = await seedArtifact(true);
    let passes = 0;
    const delayedAdapters = {
      db: {
        ...adapters.db,
        artifactVersions: new Proxy(artifactVersionRepository, {
          get(target, property) {
            const member = Reflect.get(target, property, target);
            if (property !== 'updateMany' && property !== 'activatePointerVersion') {
              return typeof member === 'function' ? member.bind(target) : member;
            }
            return async (...args: unknown[]) => {
              passes++;
              if (passes > 5) throw new Error('Reconciliation exceeded its bounded budget');
              await artifactService.update(OWNER, { id, content: `newer-${passes}` }, adapters);
              return (member as (...values: unknown[]) => Promise<unknown>).apply(target, args);
            };
          },
        }),
      },
    };
    await artifactService.update(OWNER, { id, content: 'delayed version two' }, delayedAdapters);
    expect(passes).toBe(5);
    await expectSettled(id, [2, 3, 4, 5, 6, 7]);
  });
});
