import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { SESSION_SUMMARY_TRIGGERS } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Session, sessionRepository } from './SessionModel';

/**
 * `summaryTrigger` records WHY a summary was made, the way `summaryAt` records when - it is the
 * only thing separating a summarization a user asked for from one the engine decided to run,
 * which is the question the admin session endpoint exists to answer about summarization spend.
 *
 * Two failure modes are covered here, and they hid each other:
 *  - The Mongoose enum is the fourth copy of a list also spelled out in @bike4mind/common's zod
 *    session schema, the entity type and the session.summarize event payload. It drifted
 *    ('milestone'/'growth' for values nothing produces), and BaseModel's findOneAndUpdate runs
 *    without runValidators, so an out-of-enum value persists silently rather than throwing.
 *    Hence the enum is asserted directly AND exercised through a validating write.
 *  - The stored value must survive a strict-mode `$set`, so assert on the RAW collection
 *    document. A hydrated read strips an undeclared path too and would pass against the bug.
 *
 * Sibling coverage for the same hazard class: SessionModel.taggedAt.integration.test.ts,
 * SessionModel.retrievalExclusion.test.ts.
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

describe('Session.summaryTrigger', () => {
  it('declares the same trigger list the rest of the codebase uses', () => {
    const path = Session.schema.path('summaryTrigger');
    expect(path).toBeDefined();
    expect(path.instance).toBe('String');
    expect((path as mongoose.Schema.Types.String).enumValues).toEqual([...SESSION_SUMMARY_TRIGGERS]);
  });

  // `create` validates where `sessionRepository.update` does not, so this is the leg that proves
  // the enum accepts what the producing code emits rather than just matching a constant.
  it.each([...SESSION_SUMMARY_TRIGGERS])('accepts %s on a validating insert', async trigger => {
    const session = await insertSession({ summaryTrigger: trigger });

    const stored = await Session.collection.findOne({ _id: session._id });
    expect(stored?.summaryTrigger).toBe(trigger);
  });

  // Without this the enum could be dropped entirely and every case above would still pass. Both
  // values are the ones the drifted enum used to accept, so this also pins that the drift is gone.
  it.each(['milestone', 'growth'])('rejects %s, a value outside the list', async trigger => {
    await expect(insertSession({ summaryTrigger: trigger })).rejects.toThrow(mongoose.Error.ValidationError);
  });

  // The path the summarization handler actually writes through. NOT an enum reproducer: BaseModel's
  // _plainUpdate calls findOneAndUpdate without runValidators, so this leg passed against the
  // drifted enum too. What it guards is that the path is DECLARED (strict mode drops an undeclared
  // key out of the `$set`) and that the value reaches the raw document unchanged.
  it('persists summaryTrigger alongside the summary through sessionRepository.update', async () => {
    const session = await insertSession();
    const summaryAt = new Date('2024-05-01T12:00:00.000Z');

    await sessionRepository.update({
      id: session.id,
      summary: 'A summary of the session.',
      summaryAt,
      summaryTrigger: 'earlyMilestone',
    });

    const stored = await Session.collection.findOne({ _id: session._id });
    expect(stored?.summaryTrigger).toBe('earlyMilestone');
    expect(stored?.summaryAt).toEqual(summaryAt);
  });
});
