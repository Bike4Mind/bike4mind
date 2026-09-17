import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Session, sessionRepository } from './SessionModel';

/**
 * `taggedAt` is the companion of `tags`, the way `summaryAt` is the companion of `summary`, and
 * the ONLY thing that stops the spider re-tagging a notebook it already paid an operations-model
 * completion to tag (apps/client/server/events/spider.ts gates on `!session.taggedAt`).
 *
 * The Session schema is strict (Mongoose default, not overridden in its options), so WITHOUT the
 * declared path the field is dropped from the `$set` that `sessionRepository.update` builds -
 * `tags` lands, `taggedAt` does not, and the gate reads permanently falsy. The failure is silent:
 * the write resolves and the returned document looks right, only the stored row is missing the
 * field. So assert against the RAW collection document, not a hydrated one.
 *
 * Sibling coverage for the same hazard class: SessionModel.retrievalExclusion.test.ts.
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
});

const insertSession = async (fields: Record<string, unknown> = {}) =>
  Session.create({
    name: 'probe',
    userId: 'owner-1',
    lastUpdated: new Date(),
    firstCreated: new Date(),
    ...fields,
  });

const TAGGED_AT = new Date('2024-05-01T12:00:00.000Z');

describe('Session.taggedAt survives a strict-mode write', () => {
  it('declares taggedAt as a Date path', () => {
    const path = Session.schema.path('taggedAt');
    expect(path).toBeDefined();
    expect(path.instance).toBe('Date');
  });

  it('persists taggedAt alongside tags through sessionRepository.update', async () => {
    const session = await insertSession();

    await sessionRepository.update({
      id: session.id,
      tags: [{ name: 'astronomy', strength: 7 }],
      taggedAt: TAGGED_AT,
    });

    const stored = await Session.collection.findOne({ _id: session._id });
    expect(stored?.taggedAt).toEqual(TAGGED_AT);
    expect(stored?.tags).toEqual([{ name: 'astronomy', strength: 7 }]);
  });

  // `insert` and `$set` are governed by strict mode separately, and the import path writes
  // sessions through `create` rather than the repository's update.
  it('persists taggedAt through an insert', async () => {
    const session = await insertSession({ taggedAt: TAGGED_AT });

    const stored = await Session.collection.findOne({ _id: session._id });
    expect(stored?.taggedAt).toEqual(TAGGED_AT);
  });

  // `find` -> `toObject` is the reader the spider actually uses; `findById` -> `toJSON` is a
  // different serializer, so assert on the one whose output reaches the gate.
  it('reads taggedAt back through the reader the spider uses', async () => {
    const session = await insertSession();
    await sessionRepository.update({ id: session.id, taggedAt: TAGGED_AT });

    const [reloaded] = await sessionRepository.find({ _id: session._id });
    expect(reloaded?.taggedAt).toEqual(TAGGED_AT);
  });
});
