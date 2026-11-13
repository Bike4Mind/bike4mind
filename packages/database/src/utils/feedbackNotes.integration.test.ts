import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { ADMIN_NOTE_MAX_LENGTH } from '@bike4mind/common';
import { createMongoReplSet, settleAutoIndexBuilds, MONGO_TEST_TIMEOUT_MS } from '../__test__/createMongoServer';
import { AdminAuditLogModel, adminAuditLogRepository } from '../models/infra/admin/AdminAuditLogModel';
import { User } from '../models/auth/UserModel';
import { FeedbackModel } from '../models/social/FeedbackModel';
import { FeedbackTextModel } from '../models/social/FeedbackTextModel';
import { FeedbackNoteModel } from '../models/social/FeedbackNoteModel';
import { scrubLegacyFeedbackNotes } from './feedbackNotes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoReplSet>>;
const ownerId = new mongoose.Types.ObjectId('abcdefabcdefabcdefabcdef');
const feedbackId = new mongoose.Types.ObjectId('fedcbafedcbafedcbafedcba');
const now = new Date();
const expiresAt = new Date(now.getTime() + 86400000);
const occurredAt = new Date(now.getTime() - 10000);

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await FeedbackNoteModel.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  for (const model of [User, FeedbackModel, FeedbackTextModel, FeedbackNoteModel, AdminAuditLogModel]) {
    await model.collection.deleteMany({});
  }
  await User.collection.insertOne({ _id: ownerId, username: 'reporter' });
  await FeedbackModel.collection.insertOne({
    _id: feedbackId,
    userId: String(ownerId).toUpperCase(),
    username: 'reporter',
    status: 'New',
    createdAt: occurredAt,
  });
  await FeedbackTextModel.collection.insertOne({ _id: feedbackId, content: 'Report text', expiresAt });
});
async function legacy() {
  return adminAuditLogRepository.append({
    action: 'feedback.note_added',
    occurredAt,
    category: 'support',
    severity: 'notice',
    actor: { kind: 'user', scope: 'platform', userId: 'administrator', name: 'Admin', wasAdmin: true },
    target: { kind: 'user', id: String(ownerId), displayName: 'Reporter' },
    context: { source: 'admin_ui' },
    summary: 'added an internal feedback note',
    details: { feedbackId: String(feedbackId).toUpperCase(), note: 'Private original body' },
  });
}

describe('legacy feedback note retention', () => {
  it('moves bodies with canonical ownership, original time/expiry, and repeat-safe IDs', async () => {
    const audit = await legacy();
    expect(await scrubLegacyFeedbackNotes({ now })).toEqual({ scanned: 1, migrated: 1, retired: 0 });
    const note = await FeedbackNoteModel.findById(audit.id).lean();
    expect(note).toMatchObject({
      feedbackId: String(feedbackId),
      userId: String(ownerId),
      body: 'Private original body',
      author: { id: 'administrator', name: 'Admin' },
      createdAt: occurredAt,
      expiresAt,
    });
    const raw = await AdminAuditLogModel.findById(audit.id).lean();
    expect(raw?.details).toEqual({ feedbackId: String(feedbackId), noteId: audit.id });
    expect(raw?.occurredAt).toEqual(occurredAt);
    expect(await scrubLegacyFeedbackNotes({ now })).toEqual({ scanned: 0, migrated: 0, retired: 0 });
    expect(await FeedbackNoteModel.countDocuments()).toBe(1);
  });
  it.each(['expired', 'parent missing', 'owner missing', 'owner purging', 'owner unverifiable'])(
    'retires %s text without recreating it',
    async state => {
      const audit = await legacy();
      if (state === 'expired')
        await FeedbackTextModel.collection.updateOne({ _id: feedbackId }, { $set: { expiresAt: now } });
      if (state === 'parent missing') await FeedbackModel.deleteMany({});
      if (state === 'owner missing') await User.collection.deleteMany({});
      if (state === 'owner purging')
        await User.updateOne({ _id: ownerId }, { $set: { 'deletion.purgeStartedAt': now } });
      if (state === 'owner unverifiable')
        await FeedbackModel.updateOne({ _id: feedbackId }, { $set: { userId: 'Unknown' } });
      expect(await scrubLegacyFeedbackNotes({ now })).toEqual({ scanned: 1, migrated: 0, retired: 1 });
      expect(await FeedbackNoteModel.countDocuments()).toBe(0);
      expect((await AdminAuditLogModel.findById(audit.id).lean())?.details).not.toHaveProperty('note');
    }
  );
  it.each(['   ', 'x'.repeat(ADMIN_NOTE_MAX_LENGTH + 1)])(
    'retires legacy bodies outside the shared note schema',
    async body => {
      const audit = await legacy();
      await AdminAuditLogModel.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(audit.id) },
        { $set: { 'details.note': body } }
      );
      expect(await scrubLegacyFeedbackNotes({ now })).toEqual({ scanned: 1, migrated: 0, retired: 1 });
      expect(await FeedbackNoteModel.countDocuments()).toBe(0);
    }
  );
  it('hides old inline bodies from every general repository reader before the scrub', async () => {
    const audit = await legacy();
    expect((await AdminAuditLogModel.findById(audit.id).lean())?.details?.note).toBe('Private original body');
    expect((await adminAuditLogRepository.findById(audit.id))?.details).not.toHaveProperty('note');
    expect((await adminAuditLogRepository.findByIds([audit.id]))[0].details).not.toHaveProperty('note');
    expect((await adminAuditLogRepository.list({}, { limit: 20 })).entries[0].details).not.toHaveProperty('note');
  });
  it('rolls destination creation back when the conditional source scrub fails', async () => {
    const audit = await legacy();
    vi.spyOn(AdminAuditLogModel.collection, 'updateOne').mockResolvedValueOnce({
      acknowledged: true,
      matchedCount: 0,
      modifiedCount: 0,
      upsertedCount: 0,
      upsertedId: null,
    });
    await expect(scrubLegacyFeedbackNotes({ now })).rejects.toThrow('migration source changed');
    expect(await FeedbackNoteModel.countDocuments()).toBe(0);
    expect((await AdminAuditLogModel.findById(audit.id).lean())?.details?.note).toBe('Private original body');
  });
  it('refuses a conflicting destination without overwriting either copy', async () => {
    const audit = await legacy();
    await FeedbackNoteModel.create({
      _id: audit.id,
      feedbackId: String(feedbackId),
      userId: String(ownerId),
      author: { id: 'administrator', name: 'Admin' },
      body: 'Conflicting body',
      createdAt: occurredAt,
      expiresAt,
    });
    await expect(scrubLegacyFeedbackNotes({ now })).rejects.toThrow('destination conflicts');
    expect((await FeedbackNoteModel.findById(audit.id).lean())?.body).toBe('Conflicting body');
    expect((await AdminAuditLogModel.findById(audit.id).lean())?.details?.note).toBe('Private original body');
  });
  it('keeps the application audit model immutable and declares a physical note TTL', async () => {
    const audit = await legacy();
    await expect(AdminAuditLogModel.updateOne({ _id: audit.id }, { $unset: { 'details.note': '' } })).rejects.toThrow(
      'immutable'
    );
    expect(FeedbackNoteModel.schema.indexes()).toContainEqual([
      { expiresAt: 1 },
      expect.objectContaining({ expireAfterSeconds: 0 }),
    ]);
  });
});
