import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createMocks } from 'node-mocks-http';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../../packages/database/src/__test__/createMongoServer';
import { PublishedArtifact, PublishedArtifactReport } from '@bike4mind/database';

// The rollback only exists on a real replica set; the unit test mocks withTransaction.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const audit = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: audit.record }));

vi.mock('@server/services/publish', () => ({
  invalidatePublishCdn: vi.fn(),
  toCacheTarget: (a: unknown) => a,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
        delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.DELETE = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

import handler from '../takedown';

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
beforeEach(() => {
  audit.record.mockReset();
});
afterEach(async () => {
  await PublishedArtifact.deleteMany({});
  await PublishedArtifactReport.deleteMany({});
});

const seed = async () => {
  const artifact = await PublishedArtifact.create({
    publicId: 'pub1',
    tier: 'user',
    scopeId: 'u1',
    slug: 'r-pub1',
    title: 'Report',
    ownerId: 'u1',
    source: { kind: 'reply' },
  });
  const report = await PublishedArtifactReport.create({
    publicId: 'pub1',
    artifactId: artifact.id,
    reporterId: 'reporter1',
    reason: 'spam',
  });
  return { artifact, report };
};

const postTakedown = () => {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'pub1' }, body: { reason: 'abuse' } });
  Object.assign(req, { logger: { info: vi.fn(), warn: vi.fn() }, user: { id: 'admin1', isAdmin: true } });
  return (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
};

describe('admin takedown transaction', () => {
  it('rolls back the takedown and report resolution when the audit write fails', async () => {
    const { artifact, report } = await seed();
    audit.record.mockRejectedValue(new Error('audit down'));

    await expect(postTakedown()).rejects.toThrow('audit down');

    const liveArtifact = await PublishedArtifact.findById(artifact._id).lean();
    expect(liveArtifact).toMatchObject({ deletedAt: null, deletedBy: null, moderationStatus: 'active' });
    const openReport = await PublishedArtifactReport.findById(report._id).lean();
    expect(openReport).toMatchObject({ status: 'open', resolvedBy: null, resolvedAt: null });
  });

  it('commits the takedown and resolves the report when the audit write succeeds', async () => {
    const { artifact, report } = await seed();
    audit.record.mockResolvedValue(undefined);

    await postTakedown();

    const down = await PublishedArtifact.findById(artifact._id).lean();
    expect(down?.moderationStatus).toBe('taken_down');
    expect(down?.deletedAt).toBeInstanceOf(Date);
    expect((await PublishedArtifactReport.findById(report._id).lean())?.status).toBe('actioned');
  });
});
