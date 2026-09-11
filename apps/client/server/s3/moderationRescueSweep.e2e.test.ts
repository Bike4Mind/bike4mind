import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { FabFile } from '@bike4mind/database';
import { KnowledgeType } from '@bike4mind/common';

// In-memory object store the storage mock reads. vi.hoisted so the vi.mock factory (also hoisted)
// can close over it; the test body seeds keys into it. A key present in `objects` "exists" in S3;
// a key absent throws NoSuchKey; a key in `transient` throws a non-NoSuchKey (5xx/throttle) error.
const store = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  transient: new Set<string>(),
}));

// Stub only the genuinely-external side effect: S3 (which keys "exist"). Everything else - the real
// FabFile model, the real claim/persist/release wiring in knowledgeModerationDeps, the real sweep,
// and the real moderate catch branch - runs against a real mongod. That is the point: it exercises
// the DB-level poison loop and starvation that the fully-mocked moderationRescueSweep.test.ts cannot.
vi.mock('@server/utils/storage', () => {
  const noSuchKey = () =>
    Object.assign(new Error('The specified key does not exist.'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
  const read = (key: string): Buffer => {
    if (store.transient.has(key)) throw new Error('transient storage failure (5xx/throttle)');
    const bytes = store.objects.get(key);
    if (!bytes) throw noSuchKey();
    return bytes;
  };
  const fake = {
    download: async (key: string) => read(key),
    downloadRange: async (key: string, length: number) => read(key).subarray(0, length),
  };
  const getFilesStorage = () => fake;
  return {
    getFilesStorage,
    getGeneratedImageStorage: getFilesStorage,
    getAppFilesStorage: getFilesStorage,
    getPublishedArtifactsStorage: getFilesStorage,
  };
});

import { runModerationRescueSweep } from './moderationRescueSweep';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

// Boots a real mongod, so lift the whole file onto the integration timeout.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

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
  await mongoose.connection.dropDatabase();
  store.objects.clear();
  store.transient.clear();
  vi.clearAllMocks();
});

const STALE_AGE_MS = 40 * 60_000; // older than the sweep's 30-min MODERATION_STALE_MS floor

async function seedPending(filePath: string, mimeType: string) {
  const doc = await FabFile.create({
    userId: 'user1',
    fileName: 'f',
    type: KnowledgeType.FILE,
    filePath,
    mimeType,
    moderationStatus: 'pending',
  });
  // timestamps:true stamped createdAt=now and makes it immutable to Mongoose writes, so backdate it
  // past the staleness floor through the raw driver (which bypasses the immutable guard) to seed a
  // genuinely-stale row.
  await FabFile.collection.updateOne({ _id: doc._id }, { $set: { createdAt: new Date(Date.now() - STALE_AGE_MS) } });
  return doc;
}

async function seedScanning(filePath: string, mimeType: string) {
  const doc = await FabFile.create({
    userId: 'user1',
    fileName: 'f',
    type: KnowledgeType.FILE,
    filePath,
    mimeType,
    moderationStatus: 'scanning',
  });
  // Old createdAt + old moderationClaimedAt, but a FRESH updatedAt: the stale-claim reclaim must key
  // on moderationClaimedAt (claim age), so a bumped updatedAt must not keep this crashed row stuck.
  await FabFile.collection.updateOne(
    { _id: doc._id },
    {
      $set: {
        createdAt: new Date(Date.now() - STALE_AGE_MS),
        moderationClaimedAt: new Date(Date.now() - STALE_AGE_MS),
        updatedAt: new Date(),
      },
    }
  );
  return doc;
}

describe('runModerationRescueSweep (DB integration)', () => {
  it('soft-deletes never-landed import orphans (not a content block) and does not starve a stranded row', async () => {
    // 3 import orphans: knowledge rows whose bytes never landed, so the S3 object was never written.
    // Seeded first (oldest), so a bounded window fills entirely with orphans - the head-of-line block
    // that, without a terminal give-up, is released and re-selected every run, starving the stranded
    // row forever. Keys absent -> download NoSuchKey.
    const orphanKeys = ['knowledge/user1/orphan-a', 'knowledge/user1/orphan-b', 'knowledge/user1/orphan-c'];
    for (const filePath of orphanKeys) await seedPending(filePath, 'image/png');

    // 1 genuinely-stranded row: a real (non-image) import whose scan never completed. Its object
    // EXISTS, so the download succeeds and it moderates to clean - the row the orphans must not starve.
    store.objects.set('knowledge/user1/stranded', Buffer.from('just some plain text, definitely not an image'));
    await seedPending('knowledge/user1/stranded', 'text/plain');

    // limit == orphan count, so run 1's window can be entirely orphans. Two runs converge on the same
    // terminal state regardless of natural selection order (asserted below).
    await runModerationRescueSweep({ enabled: true, limit: 3, logger });
    await runModerationRescueSweep({ enabled: true, limit: 3, logger });

    // No recurrence AND no un-appealable block: every orphan is soft-deleted (a storage-cleanup
    // outcome), so it drops out of every default query (the softDeletePlugin's find hook injects
    // deletedAt:null) - serving and this sweep's own re-selection alike - and carries no content-policy
    // 'blocked' verdict. Old release-on-missing would leave it 'pending' and re-selected every run;
    // old terminal-blocked would leave a permanent false content block - this test fails on both.
    for (const filePath of orphanKeys) {
      // Hidden from default queries (proves it is soft-deleted, not just re-labelled).
      expect(await FabFile.findOne({ filePath }).lean()).toBeNull();
      // With the soft-delete opt-in: deletedAt is stamped, and it is NOT a content-policy 'blocked'.
      const row = await FabFile.findOne({ filePath }).setOptions({ includeDeleted: true }).lean();
      expect(row?.deletedAt).toBeInstanceOf(Date);
      expect(row?.moderationStatus).not.toBe('blocked');
    }

    // No starvation: the stranded row was reached and scanned to a terminal clean, not left pending.
    const stranded = await FabFile.findOne({ filePath: 'knowledge/user1/stranded' }).lean();
    expect(stranded?.moderationStatus).toBe('clean');

    // Explicit non-recurrence: nothing selectable remains, so a further run selects nothing.
    const third = await runModerationRescueSweep({ enabled: true, limit: 3, logger });
    expect(third).toEqual({ rescanned: 0 });
  });

  it('never touches an ordinary (non-knowledge) presign orphan - no terminal verdict on arbitrary uploads', async () => {
    // An abandoned ordinary upload: a bare-key presign row past the staleness floor whose bytes never
    // landed. It is NOT an import (no knowledge/ prefix), so the sweep must leave it entirely alone -
    // no soft-delete, no 'blocked'. Stamping it would be an un-appealable false content block on a
    // storage-cleanup concern (Blocker 2). Key absent -> would NoSuchKey if it were ever downloaded.
    await seedPending('9f2c-abandoned.png', 'image/png');

    const res = await runModerationRescueSweep({ enabled: true, limit: 5, logger });
    expect(res).toEqual({ rescanned: 0 });

    const row = await FabFile.findOne({ filePath: '9f2c-abandoned.png' }).lean();
    expect(row?.moderationStatus).toBe('pending'); // untouched, not selected
    expect(row?.deletedAt ?? null).toBe(null);
    expect(row?.blockReason).toBeFalsy();
  });

  it('with moderation disabled, leaves the held pending backlog held rather than whitewashing it clean', async () => {
    // A row held 'pending' while moderation was ON. Turning moderation OFF must not let the sweep
    // stamp it terminally 'clean' (which the disabled scan path would do) - it stays held and
    // recoverable when moderation is turned back on (Blocker 1).
    store.objects.set('knowledge/user1/held', Buffer.from('some bytes'));
    await seedPending('knowledge/user1/held', 'image/png');

    const res = await runModerationRescueSweep({ enabled: false, limit: 5, logger });
    expect(res).toEqual({ rescanned: 0 });

    const row = await FabFile.findOne({ filePath: 'knowledge/user1/held' }).lean();
    expect(row?.moderationStatus).toBe('pending'); // still held, not 'clean'
    expect(row?.deletedAt ?? null).toBe(null);
  });

  it('releases (keeps pending) a transient download failure rather than retiring it', async () => {
    // Object "exists" but the read throws a non-NoSuchKey (5xx/throttle) error: the row must stay
    // recoverable ('pending'), never terminal, even though the sweep sets terminalOnMissingObject.
    store.transient.add('knowledge/user1/flaky');
    await seedPending('knowledge/user1/flaky', 'text/plain');

    const { rescanned } = await runModerationRescueSweep({ enabled: true, limit: 5, logger });
    expect(rescanned).toBe(0); // released (transient), so NOT counted as resolved/scanned
    expect(logger.warn).toHaveBeenCalled(); // but it WAS processed (released with a warning), not skipped

    const row = await FabFile.findOne({ filePath: 'knowledge/user1/flaky' }).lean();
    expect(row?.moderationStatus).toBe('pending');
    expect(row?.deletedAt ?? null).toBe(null);
  });

  it('reclaims a crashed scanning row by claim age (not updatedAt) and rescans it', async () => {
    // A claim whose scan crashed before releasing it: stuck 'scanning' with an OLD claim stamp but a
    // FRESH updatedAt. Only a moderationClaimedAt-gated reclaim frees it; an updatedAt-gated one would
    // leave it stuck forever. Object exists (non-image), so once reclaimed it resolves clean.
    store.objects.set('knowledge/user1/crashed', Buffer.from('recovered plain text, not an image'));
    await seedScanning('knowledge/user1/crashed', 'text/plain');

    await runModerationRescueSweep({ enabled: true, limit: 5, logger });

    const row = await FabFile.findOne({ filePath: 'knowledge/user1/crashed' }).lean();
    expect(row?.moderationStatus).toBe('clean');
  });
});
