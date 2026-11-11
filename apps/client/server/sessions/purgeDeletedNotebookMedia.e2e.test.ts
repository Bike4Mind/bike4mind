import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { FabFile, GenerationJobModel, Quest, Session } from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

const effects = vi.hoisted(() => ({ deleteGenerated: vi.fn(), cdnSend: vi.fn(), enqueue: vi.fn() }));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getGeneratedImageStorage: () => ({ delete: effects.deleteGenerated }),
}));
vi.mock('./generatedMediaPurgeQueue', () => ({ enqueueGeneratedMediaPurge: effects.enqueue }));
vi.mock('@aws-sdk/client-cloudfront', () => ({
  CloudFrontClient: class {
    send = effects.cdnSend;
  },
  CreateInvalidationCommand: class {
    constructor(public input: { InvalidationBatch: { Paths: { Items: string[] } } }) {}
  },
}));
vi.mock('@bike4mind/server-utils/security/wafSharedHelpers', () => ({
  resolveRouterDistributionId: () => 'E1A2B3C4D5E6F',
}));

import {
  MAX_DELETES_PER_RUN,
  PURGE_BUDGET_MS,
  SESSION_PAGE,
  purgeDeletedNotebookMedia,
  type GeneratedMediaPurgeLeftovers,
  runGeneratedMediaPurge,
} from './purgeDeletedNotebookMedia';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let database: MongoMemoryReplSet;
const collection = (name: string) => mongoose.connection.collection(mongoose.model(name).collection.name);
const logger = { info: vi.fn(), warn: vi.fn() };
const tombstone = { deletedAt: new Date() };

// A key of the generated-content shape that sorts like `name`, so fixtures stay readable.
const gk = (name: string) => {
  const dot = name.lastIndexOf('.');
  const hex = Buffer.from(name.slice(0, dot)).toString('hex').padEnd(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}${name.slice(dot)}`;
};

async function notebook(media: { images?: string[] | null; videos?: string[] | null }, deleted = true, userId = 'u1') {
  const id = new mongoose.Types.ObjectId();
  await collection(Session.modelName).insertOne({ _id: id, userId, ...(deleted ? tombstone : {}) });
  await collection(Quest.modelName).insertOne({ sessionId: String(id), ...media, ...(deleted ? tombstone : {}) });
  return String(id);
}

const deletedKeys = () => effects.deleteGenerated.mock.calls.map(([key]) => key).sort();
const invalidatedPaths = () =>
  effects.cdnSend.mock.calls.map(([cmd]) => [...cmd.input.InvalidationBatch.Paths.Items].sort());

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
}, MONGO_TEST_TIMEOUT_MS);
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  effects.deleteGenerated.mockResolvedValue(undefined);
  effects.cdnSend.mockResolvedValue({});
  effects.enqueue.mockResolvedValue(true);
  for (const modelName of mongoose.modelNames()) await collection(modelName).deleteMany({});
});

describe('purgeDeletedNotebookMedia', () => {
  it('deletes images and videos only the deleted notebook used, in one invalidation', async () => {
    const id = await notebook({ images: [gk('a.png'), gk('b.png')], videos: [gk('c.mp4')] });
    await purgeDeletedNotebookMedia([id], { logger });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(deletedKeys()).toEqual([gk('a.png'), gk('b.png'), gk('c.mp4')]);
    expect(invalidatedPaths()).toEqual([
      [`/generated/${gk('a.png')}`, `/generated/${gk('b.png')}`, `/generated/${gk('c.mp4')}`],
    ]);
  });

  it('keeps a key a live fork still shows, but not one only a deleted fork shows', async () => {
    const id = await notebook({ images: [gk('shared.png'), gk('dead-fork.png')], videos: [gk('shared.mp4')] });
    await notebook({ images: [gk('shared.png')], videos: [gk('shared.mp4')] }, false);
    await notebook({ images: [gk('dead-fork.png')] });
    await purgeDeletedNotebookMedia([id], { logger });
    expect(deletedKeys()).toEqual([gk('dead-fork.png')]);
  });

  it('keeps a key a live library file copied, but not one a deleted file copied', async () => {
    const id = await notebook({ images: [gk('kept.png'), gk('gone.png')] });
    await collection(FabFile.modelName).insertOne({ sourceMetadata: { generatedCopyKey: gk('kept.png') } });
    await collection(FabFile.modelName).insertOne({
      sourceMetadata: { generatedCopyKey: gk('gone.png') },
      ...tombstone,
    });
    await purgeDeletedNotebookMedia([id], { logger });
    expect(deletedKeys()).toEqual([gk('gone.png')]);
  });

  it('deletes a key shared only by notebooks deleted in the same call once', async () => {
    const first = await notebook({ images: [gk('both.png')] });
    const second = await notebook({ images: [gk('both.png')] });
    await purgeDeletedNotebookMedia([first, second], { logger });
    expect(deletedKeys()).toEqual([gk('both.png')]);
    expect(invalidatedPaths()).toEqual([[`/generated/${gk('both.png')}`]]);
  });

  it('stops starting deletes once the time budget is spent and still invalidates what it deleted', async () => {
    const id = await notebook({ images: Array.from({ length: 40 }, (_, i) => gk(`k${i}.png`)) });
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    effects.deleteGenerated.mockImplementationOnce(async () => {
      now.mockReturnValue(start + PURGE_BUDGET_MS + 1);
    });
    try {
      await purgeDeletedNotebookMedia([id], { logger });
    } finally {
      now.mockRestore();
    }
    const deleted = deletedKeys();
    expect(deleted.length).toBeLessThan(40);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Time budget spent'));
    expect(invalidatedPaths()).toEqual([deleted.map(key => `/generated/${key}`).sort()]);
    expect(effects.enqueue).toHaveBeenCalledTimes(1);
    const [handoff] = effects.enqueue.mock.calls[0];
    expect(handoff.sessionIds).toEqual([]);
    expect([...deleted, ...handoff.keys].sort()).toEqual(Array.from({ length: 40 }, (_, i) => gk(`k${i}.png`)).sort());
  });

  it('deletes at most one exact-path request worth per run and hands the rest to the queue', async () => {
    const images = Array.from({ length: 1500 }, (_, i) => gk(`k${i}.png`));
    const id = await notebook({ images });
    await purgeDeletedNotebookMedia([id], { logger });
    expect(effects.deleteGenerated).toHaveBeenCalledTimes(MAX_DELETES_PER_RUN);
    const sent = invalidatedPaths();
    expect(sent.map(paths => paths.length)).toEqual([MAX_DELETES_PER_RUN]);
    expect(sent.flat()).not.toContain('/generated/*');
    const [handoff] = effects.enqueue.mock.calls[0];
    expect(handoff.ownerIds).toEqual(['u1']);
    expect([...deletedKeys(), ...handoff.keys].sort()).toEqual([...images].sort());
  });

  it('never purges a key another user produced, even when only a deleted copy shows it', async () => {
    const foreign = gk('theirs.png');
    const jobOutput = gk('job.png');
    await notebook({ images: [foreign] }, true, 'u2');
    await collection(GenerationJobModel.modelName).insertOne({
      requestedBy: 'u2',
      payload: { output: { s3Key: jobOutput } },
    });
    const copy = await notebook({ images: [foreign, jobOutput, gk('own.png')] });
    await purgeDeletedNotebookMedia([copy], { logger });
    expect(deletedKeys()).toEqual([gk('own.png')]);
    expect(invalidatedPaths()).toEqual([[`/generated/${gk('own.png')}`]]);
  });

  it('never deletes or invalidates a key outside the generated-content shape', async () => {
    const junk = [
      '../other/object.png',
      'avatars/u2.png',
      'not-a-uuid.png',
      ...Array.from({ length: 3001 }, (_, i) => `x${i}.png`),
    ];
    const id = await notebook({ images: junk });
    await purgeDeletedNotebookMedia([id], { logger });
    expect(effects.deleteGenerated).not.toHaveBeenCalled();
    expect(effects.cdnSend).not.toHaveBeenCalled();
    expect(effects.enqueue).toHaveBeenCalledWith({ sessionIds: [], keys: [], ownerIds: ['u1'] }, logger);
  });

  it('does nothing for notebooks without generated media', async () => {
    const id = await notebook({ images: null, videos: [] });
    await purgeDeletedNotebookMedia([id], { logger });
    await purgeDeletedNotebookMedia([], { logger });
    expect(effects.deleteGenerated).not.toHaveBeenCalled();
    expect(effects.cdnSend).not.toHaveBeenCalled();
  });

  it('logs a storage or CloudFront failure and still purges the other keys', async () => {
    const id = await notebook({ images: [gk('fails.png'), gk('ok.png')] });
    effects.deleteGenerated.mockImplementation(async (key: string) => {
      if (key === gk('fails.png')) throw new Error('s3 down');
    });
    effects.cdnSend.mockRejectedValue(new Error('throttled'));
    await expect(purgeDeletedNotebookMedia([id], { logger })).resolves.toBeUndefined();
    expect(invalidatedPaths()).toEqual([[`/generated/${gk('ok.png')}`]]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('s3 down'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('throttled'));
  });
});

describe('runGeneratedMediaPurge', () => {
  // Two full pages plus a partial one, every notebook with its own image and one shared by all.
  async function notebooks(count = SESSION_PAGE * 2 + 5) {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) ids.push(await notebook({ images: [gk(`own${i}.png`), gk('shared.png')] }));
    return ids;
  }

  // Page lookups only; the retention queries also go through Quest.find.
  const pageFinds = (find: { mock: { calls: unknown[][] } }) =>
    find.mock.calls.filter(([filter]) => (filter as Record<string, unknown> | undefined)?.sessionId).length;

  // Moves the clock past `deadline` once the `afterFinds`-th page lookup starts.
  function expireAfterFinds(afterFinds: number, jumpMs = 2_000) {
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    const originalFind = Quest.find.bind(Quest);
    let finds = 0;
    const find = vi.spyOn(Quest, 'find').mockImplementation(((...args: Parameters<typeof Quest.find>) => {
      if ((args[0] as Record<string, unknown> | undefined)?.sessionId && ++finds === afterFinds) {
        now.mockReturnValue(start + jumpMs);
      }
      return originalFind(...args);
    }) as typeof Quest.find);
    return { deadline: start + 1_000, find, restore: () => vi.restoreAllMocks() };
  }

  it('pages the lookup and deletes a key shared across pages once', async () => {
    const ids = await notebooks();
    const find = vi.spyOn(Quest, 'find');
    try {
      const leftovers = await runGeneratedMediaPurge(
        { sessionIds: ids },
        { deadline: Date.now() + PURGE_BUDGET_MS, deletedSessionIds: new Set(ids), logger }
      );
      expect(leftovers).toEqual({ leftoverSessionIds: [], leftoverKeys: [], ownerIds: ['u1'] });
      expect(pageFinds(find)).toBe(3);
    } finally {
      vi.restoreAllMocks();
    }
    expect(deletedKeys()).toHaveLength(ids.length + 1);
    expect(effects.deleteGenerated.mock.calls.filter(([key]) => key === gk('shared.png'))).toHaveLength(1);
    expect(invalidatedPaths()).toHaveLength(1);
  });

  it('stops looking up once the budget expires mid-lookup and returns the unscanned notebooks', async () => {
    const ids = await notebooks();
    const clock = expireAfterFinds(2);
    let leftovers: GeneratedMediaPurgeLeftovers = { leftoverSessionIds: [], leftoverKeys: [], ownerIds: [] };
    try {
      leftovers = await runGeneratedMediaPurge(
        { sessionIds: ids },
        { deadline: clock.deadline, deletedSessionIds: new Set(ids), logger }
      );
      expect(pageFinds(clock.find)).toBe(2);
    } finally {
      clock.restore();
    }
    expect(leftovers.leftoverSessionIds).toEqual(ids.slice(SESSION_PAGE));
    expect(leftovers.leftoverKeys).toEqual([]);
    expect(deletedKeys()).toEqual(
      [...ids.slice(0, SESSION_PAGE).map((_, i) => gk(`own${i}.png`)), gk('shared.png')].sort()
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Time budget spent'));
  });

  it('hands the notebooks a delete request did not reach to the purge queue', async () => {
    const ids = await notebooks();
    const clock = expireAfterFinds(2, PURGE_BUDGET_MS + 1);
    try {
      await purgeDeletedNotebookMedia(ids, { logger });
    } finally {
      clock.restore();
    }
    expect(effects.enqueue).toHaveBeenCalledTimes(1);
    expect(effects.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIds: ids.slice(SESSION_PAGE), keys: [] }),
      logger
    );
  });

  it('forwards every notebook with zero queries when the deadline has already passed', async () => {
    const ids = await notebooks(3);
    const find = vi.spyOn(Quest, 'find');
    try {
      const leftovers = await runGeneratedMediaPurge(
        { sessionIds: ids },
        { deadline: Date.now() - 1, deletedSessionIds: new Set(ids), logger }
      );
      expect(leftovers).toEqual({ leftoverSessionIds: ids, leftoverKeys: [], ownerIds: [] });
      expect(find).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
    expect(effects.deleteGenerated).not.toHaveBeenCalled();
  });

  it('forwards a page whose lookup fails and still purges the next page', async () => {
    const ids = await notebooks(SESSION_PAGE + 1);
    const originalFind = Quest.find.bind(Quest);
    vi.spyOn(Quest, 'find').mockImplementationOnce((() => {
      throw new Error('lookup down');
    }) as typeof Quest.find);
    vi.spyOn(Quest, 'find').mockImplementation(((...args: Parameters<typeof Quest.find>) =>
      originalFind(...args)) as typeof Quest.find);
    let leftovers: GeneratedMediaPurgeLeftovers = { leftoverSessionIds: [], leftoverKeys: [], ownerIds: [] };
    try {
      leftovers = await runGeneratedMediaPurge(
        { sessionIds: ids },
        { deadline: Date.now() + PURGE_BUDGET_MS, deletedSessionIds: new Set(ids), logger }
      );
    } finally {
      vi.restoreAllMocks();
    }
    expect(leftovers.leftoverSessionIds).toEqual(ids.slice(0, SESSION_PAGE));
    expect(deletedKeys()).toEqual([gk(`own${SESSION_PAGE}.png`), gk('shared.png')].sort());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lookup down'));
  });

  it('deletes already-resolved keys directly and returns those the deadline cut off', async () => {
    const keys = Array.from({ length: 40 }, (_, i) => gk(`k${i}.png`));
    await notebook({ images: keys });
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    effects.deleteGenerated.mockImplementationOnce(async () => {
      now.mockReturnValue(start + PURGE_BUDGET_MS + 1);
    });
    let leftovers: GeneratedMediaPurgeLeftovers = { leftoverSessionIds: [], leftoverKeys: [], ownerIds: [] };
    try {
      leftovers = await runGeneratedMediaPurge(
        { keys, ownerIds: ['u1'] },
        { deadline: start + PURGE_BUDGET_MS, deletedSessionIds: new Set<string>(), logger }
      );
    } finally {
      now.mockRestore();
    }
    const deleted = deletedKeys();
    expect([...deleted, ...leftovers.leftoverKeys].sort()).toEqual([...keys].sort());
    expect(leftovers.leftoverKeys.length).toBeGreaterThan(0);
    expect(invalidatedPaths()).toEqual([deleted.map(key => `/generated/${key}`).sort()]);
  });

  it('re-checks direct keys: skips one a live message shows again and one another user produced', async () => {
    const [reused, foreign, own] = [gk('reused.png'), gk('theirs.png'), gk('own.png')];
    await notebook({ images: [foreign] }, true, 'u2');
    await notebook({ images: [reused, foreign, own] });
    await notebook({ images: [reused] }, false);
    const leftovers = await runGeneratedMediaPurge(
      { keys: [reused, foreign, own, 'avatars/u2.png'], ownerIds: ['u1'] },
      { deadline: Date.now() + PURGE_BUDGET_MS, deletedSessionIds: new Set<string>(), logger }
    );
    expect(deletedKeys()).toEqual([own]);
    expect(leftovers.leftoverKeys).toEqual([]);
  });

  it('deletes no direct key without an owner to check it against', async () => {
    const own = gk('own.png');
    await notebook({ images: [own] });
    await runGeneratedMediaPurge(
      { keys: [own] },
      { deadline: Date.now() + PURGE_BUDGET_MS, deletedSessionIds: new Set<string>(), logger }
    );
    expect(effects.deleteGenerated).not.toHaveBeenCalled();
  });
});
