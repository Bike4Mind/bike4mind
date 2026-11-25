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

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Overlapping saves against the REAL repositories: the unit tests stub the repos, so they cannot
 * see two requests reading the same state. Run `pnpm --filter @bike4mind/services-core build`
 * first: the service comes from the built dist.
 */

const OWNER = 'concurrency-owner';
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

async function seedArtifact(withCounter: boolean) {
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
  return id;
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
