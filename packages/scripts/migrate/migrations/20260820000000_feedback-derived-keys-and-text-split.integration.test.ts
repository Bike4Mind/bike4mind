import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Session, Quest, User } from '@bike4mind/database';
import { createMongoServer } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260820000000_feedback-derived-keys-and-text-split';

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

function rawFeedbacks() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db connection');
  return db.collection('feedbacks');
}

function rawFeedbackTexts() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db connection');
  return db.collection('feedbacktexts');
}

// Inserted via the raw driver, not FeedbackModel.create(), so the doc has none of the schema's
// new-field defaults (subject, contentStored) - a faithful stand-in for a pre-migration document.
async function insertLegacyFeedback(overrides: Record<string, unknown> = {}) {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    userId: 'user-1',
    content: 'legacy report text',
    status: 'New',
    username: 'reporter',
    userEmail: 'reporter@example.com',
    organization: 'Some Org',
    createdAt: new Date(),
    ...overrides,
  };
  await rawFeedbacks().insertOne(doc);
  return doc;
}

describe('feedback-derived-keys-and-text-split migration (real DB)', () => {
  it('backfills subject:product and no throw when promptMeta is missing entirely', async () => {
    const doc = await insertLegacyFeedback({ promptMeta: undefined });

    await migration.up();

    const migrated = await rawFeedbacks().findOne({ _id: doc._id });
    expect(migrated?.subject).toBe('product');
    expect(migrated?.questId).toBeUndefined();
    expect(migrated?.sessionId).toBeUndefined();
  });

  it('does not write a questId when the quest session belongs to a different user', async () => {
    const owner = await User.create({ username: 'owner', name: 'Owner', email: 'owner@example.com' });
    const session = await Session.create({
      name: 'a session',
      userId: owner.id,
      lastUpdated: new Date(),
      firstCreated: new Date(),
    });
    const quest = await Quest.create({ sessionId: session.id, timestamp: new Date(), type: 'message', prompt: 'p' });

    // This feedback doc's OWN userId does not match the quest's session owner.
    const doc = await insertLegacyFeedback({
      userId: 'a-different-user',
      promptMeta: { questId: quest.id },
    });

    await migration.up();

    const migrated = await rawFeedbacks().findOne({ _id: doc._id });
    expect(migrated?.questId).toBeUndefined();
    expect(migrated?.subject).toBe('product');
  });

  it('writes questId + sessionId when the quest is genuinely owned by the document userId', async () => {
    const owner = await User.create({ username: 'owner2', name: 'Owner2', email: 'owner2@example.com' });
    const session = await Session.create({
      name: 'a session',
      userId: owner.id,
      lastUpdated: new Date(),
      firstCreated: new Date(),
    });
    const quest = await Quest.create({ sessionId: session.id, timestamp: new Date(), type: 'message', prompt: 'p' });

    const doc = await insertLegacyFeedback({
      userId: owner.id,
      // The body's promptMeta.session.id deliberately disagrees with the quest's real session -
      // sessionId must come from the quest re-read, not this field.
      promptMeta: { questId: quest.id, session: { id: 'some-other-session-id' } },
    });

    await migration.up();

    const migrated = await rawFeedbacks().findOne({ _id: doc._id });
    expect(migrated?.questId).toBe(quest.id);
    expect(migrated?.sessionId).toBe(session.id);
    expect(migrated?.subject).toBe('turn');
  });

  it('sources organizationId from the users collection, never from promptMeta.session.organizationId (type-trap regression)', async () => {
    const org = await mongoose.connection.db!.collection('organizations').insertOne({ name: 'Real Org' });
    const owner = await User.create({
      username: 'owner3',
      name: 'Owner3',
      email: 'owner3@example.com',
      organizationId: org.insertedId,
    });

    const doc = await insertLegacyFeedback({
      userId: owner.id,
      // A foreign org id as a STRING on the promptMeta side - the type trap the migration must
      // not fall into (String vs ObjectId comparisons silently match nothing).
      promptMeta: { session: { organizationId: new mongoose.Types.ObjectId().toString() } },
    });

    await migration.up();

    const migrated = await rawFeedbacks().findOne({ _id: doc._id });
    expect(migrated?.organizationId).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(migrated?.organizationId)).toBe(String(org.insertedId));

    // The regression this guards: a positive query against the real ObjectId must actually match.
    const found = await rawFeedbacks().find({ organizationId: org.insertedId }).toArray();
    expect(found.map(f => f._id.toString())).toContain(doc._id.toString());
  });

  it('drops a junk (non-ObjectId) questId claim without throwing', async () => {
    const doc = await insertLegacyFeedback({ promptMeta: { questId: 'not-an-objectid' } });

    await expect(migration.up()).resolves.not.toThrow();

    const migrated = await rawFeedbacks().findOne({ _id: doc._id });
    expect(migrated?.questId).toBeUndefined();
    expect(migrated?.subject).toBe('product');
  });

  it('copies content into feedbacktexts and unsets it on the permanent document', async () => {
    const doc = await insertLegacyFeedback({ content: 'move me to the sibling' });

    await migration.up();

    const migrated = await rawFeedbacks().findOne({ _id: doc._id });
    expect(migrated?.content).toBeUndefined();
    expect(migrated?.contentStored).toBe(true);

    const text = await rawFeedbackTexts().findOne({ _id: doc._id });
    expect(text?.content).toBe('move me to the sibling');
    expect(text?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('sets contentStored:false and writes no sibling for a doc with empty content', async () => {
    const doc = await insertLegacyFeedback({ content: '' });

    await migration.up();

    const migrated = await rawFeedbacks().findOne({ _id: doc._id });
    expect(migrated?.contentStored).toBe(false);
    const text = await rawFeedbackTexts().findOne({ _id: doc._id });
    expect(text).toBeNull();
  });

  it('builds the declared indexes on both collections', async () => {
    await insertLegacyFeedback();

    await migration.up();

    const feedbackIndexNames = (await rawFeedbacks().indexes()).map(i => i.name);
    expect(feedbackIndexNames).toContain('feedback_userId_createdAt');
    expect(feedbackIndexNames).toContain('feedback_org_subject_createdAt');

    const textIndexNames = (await rawFeedbackTexts().indexes()).map(i => i.name);
    expect(textIndexNames).toContain('feedback_text_ttl');
  });

  it('is idempotent on re-run - identical final state, no duplicate sibling rows', async () => {
    await insertLegacyFeedback({ content: 'run me twice' });

    await migration.up();
    const afterFirst = await rawFeedbacks().find({}).toArray();
    const textsAfterFirst = await rawFeedbackTexts().find({}).toArray();

    await migration.up();
    const afterSecond = await rawFeedbacks().find({}).toArray();
    const textsAfterSecond = await rawFeedbackTexts().find({}).toArray();

    expect(afterSecond).toEqual(afterFirst);
    expect(textsAfterSecond).toEqual(textsAfterFirst);
  });
});
