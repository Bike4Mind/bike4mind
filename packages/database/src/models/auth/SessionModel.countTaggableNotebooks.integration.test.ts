import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Session, sessionRepository } from './SessionModel';
import { Quest } from '../content/QuestModel';

/**
 * `countTaggableNotebooks` sizes the spider's credit pre-flight for the `tags` leg
 * (apps/client/pages/api/admin/recalculate-message-counts.ts).
 *
 * The plain `{ taggedAt: null }` count it replaced priced DISPATCHES, not settlements:
 * `sessionTagging.ts` aborts at its no-quest branch before the completion and writes nothing, so
 * a questless notebook is counted again on every run while settling nothing, and a low-balance
 * admin is refused a run that would have spent nothing. Several cases below assert the delta
 * against that raw count directly, because the delta IS the fix.
 *
 * Run against a real mongod rather than mocks: both halves turn on Mongo semantics that a mock
 * cannot reproduce - `distinct` collapsing duplicates, and `softDeletePlugin` hooking `find`/
 * `findOne` but NOT `distinct`, which is why the soft-delete terms are stated explicitly.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

afterEach(async () => {
  await Session.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
  await Quest.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
});

const OWNER = 'owner-1';

const insertSession = async (fields: Record<string, unknown> = {}) =>
  Session.create({
    name: 'probe',
    userId: OWNER,
    lastUpdated: new Date(),
    firstCreated: new Date(),
    ...fields,
  });

const insertQuest = async (sessionId: string, fields: Record<string, unknown> = {}) =>
  Quest.create({
    sessionId,
    timestamp: new Date(),
    type: 'chat',
    prompt: 'How do pulsars form?',
    ...fields,
  });

/** What the pre-flight counted before this method existed. */
const rawUntaggedCount = (userId: string) =>
  Session.countDocuments({ userId, $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }], taggedAt: null });

describe('sessionRepository.countTaggableNotebooks', () => {
  it('counts an untagged notebook that has a quest', async () => {
    const session = await insertSession();
    await insertQuest(session.id);

    expect(await sessionRepository.countTaggableNotebooks(OWNER)).toBe(1);
  });

  // The headline case. Both notebooks are `taggedAt: null`, so the raw count prices two
  // operations; only one of them will ever reach the model.
  it('excludes an untagged notebook with no quests', async () => {
    const withQuest = await insertSession();
    await insertQuest(withQuest.id);
    await insertSession({ name: 'never used' });

    expect(await rawUntaggedCount(OWNER)).toBe(2);
    expect(await sessionRepository.countTaggableNotebooks(OWNER)).toBe(1);
  });

  it('excludes a notebook that already carries taggedAt', async () => {
    const tagged = await insertSession({ taggedAt: new Date() });
    await insertQuest(tagged.id);

    expect(await sessionRepository.countTaggableNotebooks(OWNER)).toBe(0);
  });

  it('excludes a soft-deleted notebook', async () => {
    const deleted = await insertSession({ deletedAt: new Date() });
    await insertQuest(deleted.id);

    expect(await sessionRepository.countTaggableNotebooks(OWNER)).toBe(0);
  });

  // `questRepository.findOne` is hooked by softDeletePlugin, so the handler does NOT see a
  // soft-deleted quest and aborts. `distinct` is not hooked, so without the explicit
  // `deletedAt: null` this notebook would be priced and still settle nothing.
  it('excludes a notebook whose only quest is soft-deleted', async () => {
    const session = await insertSession();
    await insertQuest(session.id, { deletedAt: new Date() });

    expect(await rawUntaggedCount(OWNER)).toBe(1);
    expect(await sessionRepository.countTaggableNotebooks(OWNER)).toBe(0);
  });

  it('counts a notebook with many quests once', async () => {
    const session = await insertSession();
    await insertQuest(session.id);
    await insertQuest(session.id);
    await insertQuest(session.id);

    expect(await sessionRepository.countTaggableNotebooks(OWNER)).toBe(1);
  });

  it('excludes another user notebooks', async () => {
    const theirs = await insertSession({ userId: 'owner-2' });
    await insertQuest(theirs.id);

    expect(await sessionRepository.countTaggableNotebooks(OWNER)).toBe(0);
  });

  it('returns 0 when the user has no untagged notebooks at all', async () => {
    expect(await sessionRepository.countTaggableNotebooks(OWNER)).toBe(0);
  });
});
