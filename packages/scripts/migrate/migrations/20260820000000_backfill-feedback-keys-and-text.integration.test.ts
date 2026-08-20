import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FeedbackModel, FeedbackTextModel, Quest, Session } from '@bike4mind/database';
import { createMongoServer } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260820000000_backfill-feedback-keys-and-text';

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
  for (const m of [FeedbackModel, FeedbackTextModel, Quest, Session]) {
    await mongoose.connection.db?.createCollection(m.collection.collectionName).catch(() => {});
    await m.collection.deleteMany({});
  }
});

const oid = () => new mongoose.Types.ObjectId().toString();

/** A pre-#1864 row: prose on the parent, no structured keys at all. */
async function legacyRow(fields: Record<string, unknown>) {
  const doc = {
    userId: 'user-1',
    content: 'legacy prose',
    status: 'New',
    username: 'reporter',
    ...fields,
  };
  const res = await FeedbackModel.collection.insertOne(doc as never);
  return String(res.insertedId);
}

// Real mongod: the migration's whole job is cross-collection reads plus writes, which mocks cannot
// verify - especially the ownership rule, which spans quests and sessions.
describe('backfill-feedback-keys-and-text migration (real DB)', () => {
  it('moves prose into the TTL sibling and leaves the parent copy for the read-join fallback', async () => {
    const id = await legacyRow({});

    await migration.up();

    const text = await FeedbackTextModel.findOne({ feedbackId: id }).lean();
    expect(text?.content).toBe('legacy prose');
    // Deliberately NOT unset: a half-finished run must not lose prose, and the read-join prefers
    // the sibling anyway.
    const parent = await FeedbackModel.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(parent?.content).toBe('legacy prose');
  });

  it('links a turn when the quest resolves to a session the record owner owns', async () => {
    const sessionId = oid();
    const questId = oid();
    await Session.collection.insertOne({ _id: new mongoose.Types.ObjectId(sessionId), userId: 'user-1' } as never);
    await Quest.collection.insertOne({ _id: new mongoose.Types.ObjectId(questId), sessionId } as never);
    const id = await legacyRow({ promptMeta: { questId } });

    await migration.up();

    const row = await FeedbackModel.findById(id).lean();
    expect(row?.questId).toBe(questId);
    expect(row?.sessionId).toBe(sessionId);
    expect(row?.subject).toBe('turn');
  });

  // The ownership rule. A historical questId pointing at someone else's conversation must not
  // become an authorization key, and dropping only the questId would not be enough.
  it("writes NO keys when the quest's session belongs to a different user", async () => {
    const sessionId = oid();
    const questId = oid();
    await Session.collection.insertOne({
      _id: new mongoose.Types.ObjectId(sessionId),
      userId: 'someone-else',
    } as never);
    await Quest.collection.insertOne({ _id: new mongoose.Types.ObjectId(questId), sessionId } as never);
    const id = await legacyRow({ promptMeta: { questId } });

    await migration.up();

    const row = await FeedbackModel.findById(id).lean();
    expect(row?.questId).toBeUndefined();
    expect(row?.sessionId).toBeUndefined();
    expect(row?.subject).toBe('product');
  });

  it('falls back to session scope when the quest is gone but the claimed session is owned', async () => {
    const sessionId = oid();
    await Session.collection.insertOne({ _id: new mongoose.Types.ObjectId(sessionId), userId: 'user-1' } as never);
    const id = await legacyRow({ promptMeta: { questId: oid(), session: { id: sessionId } } });

    await migration.up();

    const row = await FeedbackModel.findById(id).lean();
    expect(row?.sessionId).toBe(sessionId);
    expect(row?.questId).toBeUndefined();
    expect(row?.subject).toBe('session');
  });

  // Acceptance: documents whose promptMeta lacks the expected paths must still come out valid.
  it('defaults subject to product for rows with no promptMeta paths at all', async () => {
    const bare = await legacyRow({ promptMeta: {} });
    const none = await legacyRow({});

    await migration.up();

    expect((await FeedbackModel.findById(bare).lean())?.subject).toBe('product');
    expect((await FeedbackModel.findById(none).lean())?.subject).toBe('product');
  });

  it('never adopts a promptMeta organizationId as the authorization-grade key', async () => {
    const id = await legacyRow({ promptMeta: { session: { id: oid(), organizationId: oid() } } });

    await migration.up();

    expect((await FeedbackModel.findById(id).lean())?.organizationId).toBeUndefined();
  });

  it('is idempotent: a second run creates no duplicate text and changes no keys', async () => {
    const sessionId = oid();
    const questId = oid();
    await Session.collection.insertOne({ _id: new mongoose.Types.ObjectId(sessionId), userId: 'user-1' } as never);
    await Quest.collection.insertOne({ _id: new mongoose.Types.ObjectId(questId), sessionId } as never);
    const id = await legacyRow({ promptMeta: { questId } });

    await migration.up();
    const first = await FeedbackModel.findById(id).lean();
    await migration.up();
    const second = await FeedbackModel.findById(id).lean();

    expect(await FeedbackTextModel.countDocuments({ feedbackId: id })).toBe(1);
    expect(second?.questId).toBe(first?.questId);
    expect(second?.sessionId).toBe(first?.sessionId);
    expect(second?.subject).toBe(first?.subject);
  });

  it('builds the TTL index on the text collection', async () => {
    await migration.up();

    const idx = await FeedbackTextModel.collection.indexes();
    const ttl = idx.find(i => i.expireAfterSeconds !== undefined);
    expect(ttl?.expireAfterSeconds).toBe(90 * 24 * 60 * 60);
  });
});
