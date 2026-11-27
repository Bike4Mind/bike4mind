import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { PublishedArtifact } from '@bike4mind/database';
import type { PublishThumbnailJob } from '@bike4mind/server-utils/utils/publishThumbnails';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';

vi.mock('../utils/config', () => ({ Config: {} }));

import { backfillPublishThumbnails } from './backfillPublishThumbnails';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

const silent = () => undefined;
const sha = (n: number) => n.toString(16).padStart(64, '0');

let seq = 0;
const artifact = (over: Record<string, unknown> = {}) => {
  seq += 1;
  const publicId = `pub${seq}`;
  return PublishedArtifact.collection
    .insertOne({
      publicId,
      tier: 'user',
      scopeId: 'owner1',
      slug: `slug-${seq}`,
      ownerId: 'owner1',
      visibility: 'public',
      source: { kind: 'bundle' },
      sha256Index: sha(seq),
      deletedAt: null,
      ...over,
    })
    .then(() => publicId);
};

const run = async (opts: { dryRun?: boolean; limit?: number } = {}) => {
  const enqueue = vi.fn(async (_job: PublishThumbnailJob) => undefined);
  const result = await backfillPublishThumbnails({ dryRun: false, ...opts, enqueue, log: silent });
  return { result, enqueue };
};

describe('backfillPublishThumbnails', () => {
  it('selects only live bundles whose current version has no thumbnail', async () => {
    const never = await artifact({ sha256Index: sha(101) });
    const stale = await artifact({
      sha256Index: sha(102),
      thumbnail: { key: 'publish-thumbnails/x/old.webp', versionId: sha(999), renderedAt: new Date() },
    });
    await artifact({ sha256Index: sha(500), thumbnail: { key: 'k', versionId: sha(500), renderedAt: new Date() } });
    await artifact({ deletedAt: new Date() });
    await artifact({ moderationStatus: 'taken_down' });
    await artifact({ source: { kind: 'reply' } });
    await artifact({ source: { kind: 'fabfile' } });
    await artifact({ sha256Index: '' });
    await artifact({ sha256Index: null });

    const { result, enqueue } = await run();

    expect(result).toEqual({ selected: 2, enqueued: 2, invalid: 0 });
    expect(enqueue.mock.calls.map(([job]) => job)).toEqual([
      { publicId: never, versionId: sha(101) },
      { publicId: stale, versionId: sha(102) },
    ]);
  });

  it('dry run selects without enqueueing', async () => {
    await artifact();
    await artifact();

    const { result, enqueue } = await run({ dryRun: true });

    expect(result).toEqual({ selected: 2, enqueued: 0, invalid: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('--limit caps the selection, oldest first', async () => {
    const first = await artifact();
    const second = await artifact();
    await artifact();

    const { result, enqueue } = await run({ limit: 2 });

    expect(result.selected).toBe(2);
    expect(enqueue.mock.calls.map(([job]) => job.publicId)).toEqual([first, second]);
  });

  it('skips rows that cannot form a valid job instead of enqueueing garbage', async () => {
    await artifact({ sha256Index: 'not-a-sha' });
    const good = await artifact();

    const { result, enqueue } = await run();

    expect(result).toEqual({ selected: 2, enqueued: 1, invalid: 1 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].publicId).toBe(good);
  });

  it('a second run after the worker caught up selects nothing', async () => {
    const publicId = await artifact({ sha256Index: sha(300) });
    await PublishedArtifact.updateOne(
      { publicId },
      {
        $set: {
          thumbnail: {
            key: `publish-thumbnails/${publicId}/${sha(300)}.webp`,
            versionId: sha(300),
            renderedAt: new Date(),
          },
        },
      }
    );

    const { result, enqueue } = await run();

    expect(result.selected).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
