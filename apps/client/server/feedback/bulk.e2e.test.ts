import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { FeedbackModel, FeedbackNoteModel, FeedbackTextModel, adminAuditLogRepository } from '@bike4mind/database';
import type { RecordAdminActionFromRequestInput } from '@bike4mind/server-utils/utils/adminAudit';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import type {
  FeedbackBulkChange,
  FeedbackBulkRequest,
  FeedbackBulkSelection,
} from '@client/app/components/admin/Feedback/feedbackBulk';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const mocks = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: mocks.audit,
  userAuditTarget: async (id: string) => ({ kind: 'user', id, displayName: id }),
}));
vi.mock('@server/admin/ai/feedbackVisibility', () => ({ feedbackAiVisible: async () => false }));
import { feedbackBulk } from './bulk';

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
  mocks.audit.mockReset().mockImplementation(async (_request: unknown, input: RecordAdminActionFromRequestInput) =>
    adminAuditLogRepository.append({
      ...input,
      occurredAt: new Date(),
      category: 'support',
      severity: 'notice',
      actor: { userId: 'admin1', name: 'Admin', kind: 'user', scope: 'platform', wasAdmin: true },
      context: { source: 'admin_ui' },
    })
  );
});
const createReport = (status = 'New', organization = 'Test cohort') =>
  FeedbackModel.create({
    userId: String(new mongoose.Types.ObjectId()),
    username: 'reporter',
    status,
    organization,
    type: 'Bug',
  });
const call = (body: FeedbackBulkRequest) =>
  feedbackBulk({
    body,
    user: { id: 'admin1', isAdmin: true },
  } as Request);
const close: FeedbackBulkChange = { action: 'status', status: 'Closed', resolution: 'fixed' };

describe('feedback bulk preview and apply', () => {
  it.each(['explicit', 'allMatching'] as const)(
    'closes and deletes a %s selection with exact counts and one audit per change',
    async mode => {
      const first = await createReport();
      const second = await createReport('InProgress');
      const outside = await createReport('New', 'Outside');
      const selection: FeedbackBulkSelection =
        mode === 'explicit'
          ? { mode, ids: [first.id, second.id] }
          : { mode, filters: { organization: ['Test cohort'], sort: 'desc' } };
      const preview = await call({ selection, change: close, preview: true });
      expect(preview.count).toBe(2);
      expect(await FeedbackModel.countDocuments({ status: 'Closed' })).toBe(0);
      const result = await call({
        selection,
        change: close,
        preview: false,
        reason: 'Resolved after review',
        expectedCount: preview.count,
        fingerprint: preview.fingerprint,
      });
      expect(result).toMatchObject({ count: preview.count, applied: true });
      expect(await FeedbackModel.countDocuments({ status: 'Closed', resolution: 'fixed', handledBy: 'admin1' })).toBe(
        2
      );
      expect((await FeedbackModel.findById(outside.id))?.status).toBe('New');
      const unchanged = await call({ selection, change: close, preview: true });
      expect(unchanged.count).toBe(0);
      const deletion = await call({ selection, change: { action: 'delete' }, preview: true });
      expect(deletion.count).toBe(2);
      await FeedbackNoteModel.collection.insertOne({ feedbackId: first.id });
      await FeedbackTextModel.collection.insertOne({ _id: first._id, content: 'Private text' });
      await call({
        selection,
        change: { action: 'delete' },
        preview: false,
        reason: 'Test submission removed',
        expectedCount: deletion.count,
        fingerprint: deletion.fingerprint,
      });
      expect(await FeedbackModel.countDocuments()).toBe(1);
      expect(await FeedbackNoteModel.countDocuments()).toBe(0);
      expect(await FeedbackTextModel.countDocuments()).toBe(0);
      const { entries } = await adminAuditLogRepository.list({}, { limit: 20 });
      expect(entries).toHaveLength(4);
      for (const id of [first.id, second.id]) {
        expect(
          entries
            .filter(entry => entry.details?.feedbackId === id)
            .map(entry => entry.action)
            .sort()
        ).toEqual(['feedback.deleted', 'feedback.status_changed']);
      }
    }
  );

  it('rejects changed cohorts, even when their count stays the same', async () => {
    const first = await createReport();
    const selection: FeedbackBulkSelection = { mode: 'allMatching', filters: { status: ['New'], sort: 'desc' } };
    const preview = await call({ selection, change: close, preview: true });
    await FeedbackModel.deleteOne({ _id: first._id });
    await createReport();
    await expect(
      call({
        selection,
        change: close,
        preview: false,
        reason: 'Resolved after review',
        expectedCount: preview.count,
        fingerprint: preview.fingerprint,
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('rejects changed reports and incorrect expected counts before auditing', async () => {
    const report = await createReport();
    const selection: FeedbackBulkSelection = { mode: 'explicit', ids: [report.id] };
    const preview = await call({ selection, change: close, preview: true });
    await expect(
      call({
        selection,
        change: close,
        preview: false,
        reason: 'Resolved after review',
        expectedCount: 0,
        fingerprint: preview.fingerprint,
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    await FeedbackModel.updateOne({ _id: report._id }, { $set: { status: 'InProgress' } });
    await expect(
      call({
        selection,
        change: close,
        preview: false,
        reason: 'Resolved after review',
        expectedCount: 1,
        fingerprint: preview.fingerprint,
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('bounds explicit and all-matching requests without silently truncating', async () => {
    const ids = Array.from({ length: 101 }, () => String(new mongoose.Types.ObjectId()));
    await expect(call({ selection: { mode: 'explicit', ids }, change: close, preview: true })).rejects.toMatchObject({
      statusCode: 400,
    });
    await FeedbackModel.insertMany(ids.map(_id => ({ _id, userId: 'reporter', username: 'reporter', status: 'New' })));
    await expect(
      call({ selection: { mode: 'allMatching', filters: { sort: 'desc' } }, change: close, preview: true })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('rolls back the entire batch if an audit fails', async () => {
    const first = await createReport();
    const second = await createReport();
    const selection: FeedbackBulkSelection = { mode: 'explicit', ids: [first.id, second.id] };
    const preview = await call({ selection, change: close, preview: true });
    const append = mocks.audit.getMockImplementation()!;
    mocks.audit.mockImplementationOnce(append).mockRejectedValueOnce(new Error('Audit unavailable'));
    await expect(
      call({
        selection,
        change: close,
        preview: false,
        reason: 'Resolved after review',
        expectedCount: 2,
        fingerprint: preview.fingerprint,
      })
    ).rejects.toThrow('Audit unavailable');
    expect(await FeedbackModel.countDocuments({ status: 'New' })).toBe(2);
    expect((await adminAuditLogRepository.list({}, { limit: 20 })).entries).toHaveLength(0);
  });

  it('requires a reason, preview, resolution and an original outside the selection', async () => {
    const report = await createReport();
    const selection: FeedbackBulkSelection = { mode: 'explicit', ids: [report.id] };
    await expect(call({ selection, change: close, preview: false })).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      call({ selection, change: { action: 'status', status: 'Closed' }, preview: true })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      call({
        selection,
        change: { ...close, resolution: 'duplicate', resolutionDuplicateId: report.id },
        preview: true,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
