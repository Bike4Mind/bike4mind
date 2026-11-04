import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { FabFile } from '@bike4mind/database';

// vitest.setup.ts passes this module through for every other suite.
vi.unmock('@server/files/pendingUploads');
// The tier read reaches subscriptions; this suite is about the pending query, so every caller is free tier.
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateTier: async () => 'free' }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ isDevelopment: () => false }));

import { admitPendingUploads, PENDING_UPLOAD_WINDOW_MS } from './pendingUploads';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const ME = 'uploader';
const OTHER = 'teammate';
const req = { user: { id: ME, isAdmin: false, tags: [] } } as unknown as Parameters<typeof admitPendingUploads>[0];

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await FabFile.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await FabFile.collection.deleteMany({});
});

const row = (fields: Record<string, unknown> = {}) => ({
  userId: ME,
  fileName: 'f.txt',
  filePath: `${new mongoose.Types.ObjectId().toString()}.txt`,
  fileSize: 100,
  clientUpload: true,
  status: 'pending',
  createdAt: new Date(Date.now() - 60_000),
  ...fields,
});

const seed = (...rows: Record<string, unknown>[]) => FabFile.collection.insertMany(rows.map(fields => row(fields)));

describe('admitPendingUploads against a real database', () => {
  it('counts only pending, live client uploads created inside the window', async () => {
    await seed(
      {},
      { fileSize: 20 },
      // Just inside the window still counts.
      { createdAt: new Date(Date.now() - PENDING_UPLOAD_WINDOW_MS + 60_000) },
      // Abandoned: past the window.
      { createdAt: new Date(Date.now() - PENDING_UPLOAD_WINDOW_MS - 60_000) },
      // Landed.
      { status: 'complete' },
      // Written server-side, not a client upload.
      { clientUpload: false },
      { clientUpload: undefined },
      // Soft-deleted.
      { deletedAt: new Date() },
      // Another user's personal upload.
      { userId: OTHER }
    );

    const pending = await admitPendingUploads(req, 1, [undefined]);

    expect(pending.count).toBe(3);
    expect(pending.bytesFor(undefined)).toBe(220);
  });

  it("reserves an org pool's rows from every uploader, and keeps them out of the personal pool", async () => {
    await seed(
      { fileSize: 1 },
      { organizationId: 'org-1', fileSize: 10 },
      { organizationId: 'org-1', fileSize: 100, userId: OTHER },
      { organizationId: 'org-2', fileSize: 1_000, userId: OTHER },
      { organizationId: 'org-1', fileSize: 10_000, userId: OTHER, status: 'complete' }
    );

    const pending = await admitPendingUploads(req, 1, [undefined, 'org-1']);

    // The caller's personal row and their own org-1 row; the teammate's rows never count toward the cap.
    expect(pending.count).toBe(2);
    expect(pending.bytesFor(undefined)).toBe(1);
    expect(pending.bytesFor('org-1')).toBe(110);
    // org-2 was not named, so only the caller's own rows there (none) are read.
    expect(pending.bytesFor('org-2')).toBe(0);
  });

  it('refuses once the caller holds the default 250 in-flight uploads', async () => {
    await FabFile.collection.insertMany(Array.from({ length: 250 }, () => row()));

    await expect(admitPendingUploads(req, 1, [])).rejects.toMatchObject({
      additionalInfo: { code: 'pending_upload_limit', details: { limit: 250, pending: 250, requested: 1 } },
    });
  });

  it('serves the org-pool branch from the partial pending-upload index', async () => {
    // An org with a large landed history: the org-wide index would walk all of it.
    await FabFile.collection.insertMany(
      Array.from({ length: 300 }, () => row({ organizationId: 'org-1', userId: OTHER, status: 'complete' }))
    );
    await seed({ organizationId: 'org-1', userId: OTHER });

    const plan = await FabFile.collection
      .find({
        organizationId: { $in: ['org-1'], $type: 'string' },
        clientUpload: true,
        status: 'pending',
        deletedAt: null,
        createdAt: { $gte: new Date(Date.now() - PENDING_UPLOAD_WINDOW_MS) },
      })
      .explain();

    const stages: Array<{ stage?: string; indexName?: string }> = [];
    const walk = (node: { inputStage?: unknown; inputStages?: unknown[] } | undefined) => {
      if (!node) return;
      stages.push(node as { stage?: string; indexName?: string });
      walk(node.inputStage as typeof node);
      (node.inputStages ?? []).forEach(child => walk(child as typeof node));
    };
    walk(plan.queryPlanner.winningPlan);

    expect(stages.some(s => s.stage === 'IXSCAN' && s.indexName === 'organizationId_1_createdAt_1')).toBe(true);
  });
});
