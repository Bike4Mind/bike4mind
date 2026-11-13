import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { FeedbackModel, adminAuditLogRepository } from '@bike4mind/database';
import type { RecordAdminActionFromRequestInput } from '@bike4mind/server-utils/utils/adminAudit';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import type { FeedbackBulkChange, FeedbackBulkRequest } from '@client/app/components/admin/Feedback/feedbackBulk';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  userAuditTarget: async (id: string) => ({ kind: 'user', id, displayName: id }),
  recordAdminActionFromRequest: async (_req: unknown, input: RecordAdminActionFromRequestInput) =>
    adminAuditLogRepository.append({
      ...input,
      occurredAt: new Date(),
      category: 'support',
      severity: 'notice',
      actor: { userId: 'admin1', name: 'Admin', kind: 'user', scope: 'platform', wasAdmin: true },
      context: { source: 'admin_ui' },
    }),
}));
import { feedbackBulk } from './bulk';
let mongo: MongoMemoryReplSet;
beforeAll(async () => {
  mongo = await createMongoReplSet();
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

it('closes matching reports as duplicates of the original with per-report persisted audit and backlink', async () => {
  const create = () => FeedbackModel.create({ userId: 'reporter', username: 'reporter', status: 'New', type: 'Bug' });
  const original = await create();
  const first = await create();
  const second = await create();
  const selection = { mode: 'explicit', ids: [first.id, second.id] } as const;
  const change: FeedbackBulkChange = {
    action: 'status',
    status: 'Closed',
    resolution: 'duplicate',
    resolutionDuplicateId: original.id,
  };
  const call = (body: FeedbackBulkRequest) => feedbackBulk({ body, user: { id: 'admin1', isAdmin: true } } as Request);
  const preview = await call({ selection: { ...selection, ids: [...selection.ids] }, change, preview: true });
  expect(preview.count).toBe(2);
  const result = await call({
    selection: { ...selection, ids: [...selection.ids] },
    change,
    preview: false,
    reason: 'Same issue reported more than once',
    expectedCount: preview.count,
    fingerprint: preview.fingerprint,
  });
  expect(result).toMatchObject({ applied: true, count: 2 });
  expect((await FeedbackModel.findById(original.id))?.status).toBe('New');
  const { entries } = await adminAuditLogRepository.list({}, { limit: 10 });
  expect(entries).toHaveLength(2);
  for (const id of selection.ids) {
    const report = await FeedbackModel.findById(id);
    expect(report).toMatchObject({
      status: 'Closed',
      resolution: 'duplicate',
      resolutionDuplicateId: original.id,
      handledBy: 'admin1',
    });
    const entry = entries.find(item => item.details?.feedbackId === id);
    expect(entry).toMatchObject({ action: 'feedback.status_changed', reason: 'Same issue reported more than once' });
    expect(entry?.changes).toEqual(
      expect.arrayContaining([
        { field: 'resolution', before: null, after: 'duplicate' },
        { field: 'resolutionDuplicateId', before: null, after: original.id },
      ])
    );
    expect(report?.handledAuditEntryId).toBe(entry?.id);
  }
});
