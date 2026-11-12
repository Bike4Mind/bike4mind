import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { FeedbackModel, FeedbackNoteModel, User, adminAuditLogRepository, withTransaction } from '@bike4mind/database';
import type { RecordAdminActionFromRequestInput } from '@bike4mind/server-utils/utils/adminAudit';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
type Handler = (request: Request, response: Response) => Promise<unknown>;
const mocks = vi.hoisted(() => ({
  patch: null as Handler | null,
  delete: null as Handler | null,
  get: null as Handler | null,
  post: null as Handler | null,
  audit: vi.fn(),
  beforeAudit: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    patch: (handler: Handler) => {
      mocks.patch = handler;
      return chain;
    },
    delete: (handler: Handler) => {
      mocks.delete = handler;
      return chain;
    },
    get: (handler: Handler) => {
      mocks.get = handler;
      return chain;
    },
    post: (handler: Handler) => {
      mocks.post = handler;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: mocks.audit,
  userAuditTarget: async (id: string) => ({ kind: 'user', id, displayName: id }),
}));

await import('../status');
await import('../../../../feedback/[id]/delete');
await import('../history');
let replicaSet: MongoMemoryReplSet;
beforeAll(async () => {
  replicaSet = await createMongoReplSet();
  await mongoose.connect(replicaSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await replicaSet?.stop();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await mongoose.connection.dropDatabase();
});
beforeEach(() => {
  mocks.beforeAudit = undefined;
  mocks.audit.mockReset().mockImplementation(async (_request: unknown, input: RecordAdminActionFromRequestInput) => {
    const beforeAudit = mocks.beforeAudit;
    mocks.beforeAudit = undefined;
    await beforeAudit?.();
    return adminAuditLogRepository.append({
      ...input,
      occurredAt: new Date(),
      category: 'support',
      severity: 'notice',
      actor: { userId: 'admin1', name: 'Admin', kind: 'user', scope: 'platform', wasAdmin: true },
      context: { source: 'admin_ui' },
    });
  });
});
const reporterId = String(new mongoose.Types.ObjectId());
const createReport = async () => {
  await User.updateOne({ _id: reporterId }, { $set: { username: 'reporter' } }, { upsert: true });
  return FeedbackModel.create({ userId: reporterId, username: 'reporter', status: 'New', type: 'Bug' });
};
const postNote = async (id: string) => {
  const { req, res } = createMocks({ method: 'POST', query: { id }, body: { note: 'Private note' } });
  Object.assign(req, { user: { id: 'admin1', username: 'Admin', isAdmin: true } });
  await mocks.post!(req as unknown as Request, res as unknown as Response);
  return res;
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
};
const call = async (method: 'PATCH' | 'DELETE', id: string, body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method, query: { id }, body });
  Object.assign(req, { user: { id: 'admin1', isAdmin: true }, ability: { can: () => true } });
  await (method === 'PATCH' ? mocks.patch! : mocks.delete!)(req as unknown as Request, res as unknown as Response);
  return res._getJSONData() as { auditEntryId: string };
};

describe('feedback status and deletion transactions', () => {
  it('keeps notes out of reporter documents and reads audited notes through admin history', async () => {
    const report = await createReport();
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: report.id },
      body: { note: 'Private reproduction details' },
    });
    Object.assign(req, { user: { id: 'admin1', isAdmin: true } });
    await mocks.post!(req as unknown as Request, res as unknown as Response);
    expect(res._getStatusCode()).toBe(201);
    const stored = await FeedbackModel.findById(report.id);
    expect(JSON.stringify(stored?.toJSON())).not.toContain('Private reproduction details');
    const read = createMocks({ method: 'GET', query: { id: report.id } });
    await mocks.get!(read.req as unknown as Request, read.res as unknown as Response);
    expect(read.res._getJSONData().items[0]).toMatchObject({ author: 'Admin', note: 'Private reproduction details' });
  });

  it('restores the closed resolution when undoing a reopen', async () => {
    const report = await createReport();
    await call('PATCH', report.id, { status: 'Closed', resolution: 'wont_fix' });
    const reopened = await call('PATCH', report.id, { status: 'New' });
    expect((await FeedbackModel.findById(report.id))?.resolution).toBeUndefined();
    await call('PATCH', report.id, { status: 'Closed', undoOf: reopened.auditEntryId });
    expect((await FeedbackModel.findById(report.id))?.resolution).toBe('wont_fix');
  });

  it('rejects an old undo after the same admin cycles back to the same status', async () => {
    const report = await createReport();
    const first = await call('PATCH', report.id, { status: 'Closed', resolution: 'fixed', expectedStatus: 'New' });
    await call('PATCH', report.id, { status: 'InProgress', expectedStatus: 'Closed' });
    const latest = await call('PATCH', report.id, {
      status: 'Closed',
      resolution: 'wont_fix',
      expectedStatus: 'InProgress',
    });
    await expect(
      call('PATCH', report.id, { status: 'New', expectedStatus: 'Closed', undoOf: first.auditEntryId })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await FeedbackModel.findById(report.id))?.handledAuditEntryId).toBe(latest.auditEntryId);
    await call('PATCH', report.id, { status: 'InProgress', expectedStatus: 'Closed', undoOf: latest.auditEntryId });
    expect((await FeedbackModel.findById(report.id))?.status).toBe('InProgress');
  });

  it('rolls back the appended status audit if the report write fails', async () => {
    const report = await createReport();
    vi.spyOn(FeedbackModel, 'updateOne').mockRejectedValueOnce(new Error('report write failed'));
    await expect(call('PATCH', report.id, { status: 'Closed', resolution: 'fixed' })).rejects.toThrow(
      'report write failed'
    );
    expect((await FeedbackModel.findById(report.id))?.status).toBe('New');
    expect((await adminAuditLogRepository.list({}, { limit: 20 })).entries).toEqual([]);
  });

  it('rolls back deletion when the required audit write fails', async () => {
    const report = await createReport();
    mocks.audit.mockRejectedValueOnce(new Error('audit write failed'));
    await expect(call('DELETE', report.id, { reason: 'Duplicate report' })).rejects.toThrow('audit write failed');
    expect(await FeedbackModel.findById(report.id)).not.toBeNull();
  });

  it('audits the deleted state once and refuses a duplicate deletion', async () => {
    const report = await createReport();
    await FeedbackModel.updateOne({ _id: report.id }, { $set: { status: 'Closed' } });
    await call('DELETE', report.id, { reason: 'Duplicate report' });
    await expect(call('DELETE', report.id, { reason: 'Duplicate report' })).rejects.toMatchObject({ statusCode: 404 });
    const { entries } = await adminAuditLogRepository.list({}, { limit: 20 });
    expect(entries).toHaveLength(1);
    expect(entries[0].details).toMatchObject({ feedbackId: report.id, status: 'Closed' });
  });
  it('rolls back private note creation when the strict audit fails', async () => {
    const report = await createReport();
    mocks.audit.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(postNote(report.id)).rejects.toThrow('audit unavailable');
    expect(await FeedbackNoteModel.countDocuments()).toBe(0);
  });
  it('joins canonical note IDs but hides expired bodies before the TTL monitor runs', async () => {
    const report = await createReport();
    await postNote(report.id.toUpperCase());
    const note = await FeedbackNoteModel.findOne().lean();
    expect(note).toMatchObject({ feedbackId: report.id, userId: reporterId });
    await FeedbackNoteModel.collection.updateOne({ _id: note!._id }, { $set: { expiresAt: new Date(0) } });
    const { req, res } = createMocks({ method: 'GET', query: { id: report.id.toUpperCase() } });
    await mocks.get!(req as unknown as Request, res as unknown as Response);
    expect(res._getJSONData().items[0]).not.toHaveProperty('note');
  });
  it('removes committed notes in the same transaction as report deletion', async () => {
    const report = await createReport();
    await postNote(report.id);
    await call('DELETE', report.id, { reason: 'Report removed' });
    expect(await FeedbackNoteModel.countDocuments()).toBe(0);
  });
  it('serializes a note already in flight with report deletion', async () => {
    const report = await createReport();
    const entered = deferred();
    const release = deferred();
    mocks.beforeAudit = async () => {
      entered.resolve();
      await release.promise;
    };
    const note = postNote(report.id);
    await entered.promise;
    const deletes = vi.spyOn(FeedbackModel, 'deleteOne');
    const deletion = call('DELETE', report.id, { reason: 'Report removed' });
    const settled = Promise.allSettled([note, deletion]);
    try {
      await vi.waitFor(() => expect(deletes).toHaveBeenCalled());
    } finally {
      release.resolve();
      await settled;
    }
    await Promise.all([note, deletion]);
    expect(await FeedbackModel.findById(report.id)).toBeNull();
    expect(await FeedbackNoteModel.countDocuments()).toBe(0);
  });
  it('refuses a note that starts while the reporter purge claim is pending', async () => {
    const report = await createReport();
    const entered = deferred();
    const release = deferred();
    const writes = vi.spyOn(User, 'updateOne');
    const purge = withTransaction(async () => {
      await User.updateOne({ _id: reporterId }, { $set: { 'deletion.purgeStartedAt': new Date() } });
      entered.resolve();
      await release.promise;
      await FeedbackNoteModel.deleteMany({ userId: reporterId });
    });
    await entered.promise;
    const note = postNote(report.id).catch((error: unknown) => error);
    const settled = Promise.allSettled([purge, note]);
    try {
      await vi.waitFor(() => expect(writes.mock.calls.length).toBeGreaterThanOrEqual(2));
    } finally {
      release.resolve();
      await settled;
    }
    await purge;
    expect(await note).toMatchObject({ statusCode: 404 });
    expect(await FeedbackNoteModel.countDocuments()).toBe(0);
  });
});
