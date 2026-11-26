import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { z } from 'zod';
import { BRIEF_LIMITS } from '@bike4mind/common';
import {
  User,
  IngestedEmailModel,
  EmailTriageItemModel,
  emailTriageItemRepository,
  AssistantBriefModel,
  assistantBriefRepository,
  type EmailTriageItemInput,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { triageEmail, type EmailTriageDeps } from './emailTriage';
import { composeBrief, type BriefComposeDeps } from '../events/briefCompose';
import { loadPendingBriefEmails } from '../events/loadPendingBriefEmails';
import { assembleBrief, briefedEmailIds, type BriefApproval } from '../events/briefCompose.composition';
import sectionIndexMigration from '../../../../packages/scripts/migrate/migrations/20261118164439_ensure-email-triage-section-pending-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoReplSet>>;
const userId = new mongoose.Types.ObjectId().toString();
const end = new Date('2030-01-01T00:00:00Z');
const start = new Date('2020-01-01T00:00:00Z');
const reply = JSON.stringify({
  kind: 'decision',
  summary: 'DELETED_EMAIL_SENTINEL',
  draftReply: { body: 'DELETED_DRAFT_SENTINEL' },
});
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await EmailTriageItemModel.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await User.collection.deleteMany({});
  await IngestedEmailModel.collection.deleteMany({});
  await EmailTriageItemModel.collection.deleteMany({});
  await AssistantBriefModel.collection.deleteMany({});
  await User.collection.insertOne({ _id: new mongoose.Types.ObjectId(userId), __v: 0 });
});

async function createEmail() {
  const email = await IngestedEmailModel.create({
    userId,
    messageId: new mongoose.Types.ObjectId().toString(),
    threadId: 'thread',
    from: 'sender@example.com',
    to: ['owner@example.com'],
    subject: 'Renewal',
    date: new Date(),
    receivedAt: new Date(),
  });
  return { id: email._id.toString(), userId, from: email.from, subject: email.subject };
}

function triageDeps(complete: EmailTriageDeps['complete']): EmailTriageDeps {
  return {
    enabled: async () => true,
    items: emailTriageItemRepository,
    emailExists: async emailId => (await IngestedEmailModel.findById(emailId)) !== null,
    removeBriefItems: (owner, ids) => assistantBriefRepository.removeEmailSourcedItems(owner, ids),
    complete,
    logger,
  };
}

function triageInput(email: Awaited<ReturnType<typeof createEmail>>): EmailTriageItemInput {
  return {
    userId: email.userId,
    emailId: email.id,
    kind: 'decision',
    summary: 'First result',
    model: 'fake-model',
    tokensUsed: 1,
  };
}

async function composeNextBrief() {
  const brief = await assistantBriefRepository.createComposing({ userId, periodStart: start, periodEnd: end });
  const deps: BriefComposeDeps = {
    now: () => end,
    users: { findById: async () => ({ id: userId }) },
    briefs: assistantBriefRepository,
    loadActivity: async () => ({
      periodStart: start,
      periodEnd: end,
      runs: [],
      approvals: [],
      questions: [],
      emails: await loadPendingBriefEmails(userId, end),
      delegations: [],
      reminders: [],
      obligations: [],
    }),
    canCompose: async () => 'ok',
    complete: async () => JSON.stringify({ headline: 'Your brief' }),
    push: async () => undefined,
    emails: emailTriageItemRepository,
    delegations: { markBriefed: async () => 0 },
    logger,
  };
  await composeBrief(deps, { briefId: brief._id.toString(), userId });
  return AssistantBriefModel.findById(brief._id).lean().orFail();
}

it('does not resurrect a deleted email after a late model reply and one failed compensation delete', async () => {
  const email = await createEmail();
  const started = Promise.withResolvers<void>();
  const heldReply = Promise.withResolvers<void>();
  const complete = vi.fn(async () => {
    started.resolve();
    await heldReply.promise;
    return { reply, model: 'fake-model', tokensUsed: 1 };
  });
  const pending = triageEmail(triageDeps(complete), { email, analysis: {} });
  await started.promise;
  // Same ordering as the actual delete route: source first, then both derived stores.
  await IngestedEmailModel.deleteMany({ _id: email.id, userId });
  await emailTriageItemRepository.deleteByEmailIds(userId, [email.id]);
  await assistantBriefRepository.removeEmailSourcedItems(userId, [email.id]);
  const compensation = vi.spyOn(emailTriageItemRepository, 'deleteByEmailIds');
  compensation.mockRejectedValueOnce(new Error('one compensation delete failed'));
  heldReply.resolve();
  await pending;
  const stored = await composeNextBrief();
  expect(stored.status).toBe('ready');
  expect({ compensationFaultObserved: compensation.mock.calls.length > 0, decisions: stored.decisions }).toEqual({
    compensationFaultObserved: false,
    decisions: [],
  });
  expect(await EmailTriageItemModel.countDocuments({ emailId: email.id })).toBe(0);
  expect(complete).toHaveBeenCalledOnce();
});

it('stores a live email and carries its real summary and draft into the next brief', async () => {
  const email = await createEmail();
  expect(
    await triageEmail(
      triageDeps(async () => ({ reply, model: 'fake-model', tokensUsed: 1 })),
      { email, analysis: {} }
    )
  ).toBe('created');
  const stored = await composeNextBrief();
  expect(stored.status).toBe('ready');
  expect(stored.decisions).toMatchObject([
    { text: 'DELETED_EMAIL_SENTINEL', source: { emailId: email.id }, draftReply: { body: 'DELETED_DRAFT_SENTINEL' } },
  ]);
});

it.each(['missing-email', 'deleted-email', 'wrong-owner', 'missing-owner', 'purging-owner'])(
  'does not admit triage for %s',
  async condition => {
    const email = await createEmail();
    const input = triageInput(email);
    if (condition === 'missing-email') input.emailId = new mongoose.Types.ObjectId().toString();
    if (condition === 'deleted-email') await IngestedEmailModel.deleteMany({ _id: email.id });
    if (condition === 'wrong-owner') {
      input.userId = new mongoose.Types.ObjectId().toString();
      await User.collection.insertOne({ _id: new mongoose.Types.ObjectId(input.userId) });
    }
    if (condition === 'missing-owner') await User.collection.deleteMany({});
    if (condition === 'purging-owner') {
      await User.updateOne(
        { _id: userId },
        { $set: { 'deletion.purgeStartedAt': new Date() } },
        { runValidators: true }
      );
    }
    expect(await emailTriageItemRepository.storeForLiveEmail(input)).toEqual({ status: 'unavailable' });
    expect(await EmailTriageItemModel.countDocuments()).toBe(0);
  }
);

it('rolls back both admission fences and the inserted triage after a persistence error', async () => {
  const email = await createEmail();
  const insert = EmailTriageItemModel.collection.updateOne.bind(EmailTriageItemModel.collection);
  vi.spyOn(EmailTriageItemModel.collection, 'updateOne').mockImplementationOnce(async (...args) => {
    await insert(...args);
    throw new Error('failure after actual triage insert');
  });
  await expect(emailTriageItemRepository.storeForLiveEmail(triageInput(email))).rejects.toThrow(
    'failure after actual triage insert'
  );
  expect((await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) }))?.__v).toBe(0);
  const source = await IngestedEmailModel.collection.findOne({ _id: new mongoose.Types.ObjectId(email.id) });
  expect(source?.__v).toBe(0);
  expect(await EmailTriageItemModel.countDocuments()).toBe(0);
});

it('serializes a source delete behind a writer already admitted inside the transaction', async () => {
  const email = await createEmail();
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const deleteStarted = Promise.withResolvers<void>();
  const sourceWrite = IngestedEmailModel.collection.updateOne.bind(IngestedEmailModel.collection);
  vi.spyOn(IngestedEmailModel.collection, 'updateOne').mockImplementationOnce(async (...args) => {
    const result = await sourceWrite(...args);
    admitted.resolve();
    await release.promise;
    return result;
  });
  const sourceDelete = IngestedEmailModel.collection.updateMany.bind(IngestedEmailModel.collection);
  vi.spyOn(IngestedEmailModel.collection, 'updateMany').mockImplementationOnce(async (...args) => {
    const pending = sourceDelete(...args);
    deleteStarted.resolve();
    return pending;
  });
  const stored = emailTriageItemRepository.storeForLiveEmail(triageInput(email));
  await admitted.promise;
  const deletion = IngestedEmailModel.deleteMany({ _id: email.id, userId });
  const deleteResult = Promise.resolve(deletion);
  await deleteStarted.promise;
  release.resolve();
  expect(await stored).toEqual({ status: 'created' });
  await deleteResult;
  await emailTriageItemRepository.deleteByEmailIds(userId, [email.id]);
  await assistantBriefRepository.removeEmailSourcedItems(userId, [email.id]);
  expect(await IngestedEmailModel.findById(email.id)).toBeNull();
  expect(await EmailTriageItemModel.countDocuments({ emailId: email.id })).toBe(0);
  const source = await IngestedEmailModel.collection.findOne({ _id: new mongoose.Types.ObjectId(email.id) });
  expect(source?.__v).toBe(1);
});

it('retries a real write conflict without repeating either model call and keeps the first triage', async () => {
  const email = await createEmail();
  const firstAdmitted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const conflict = Promise.withResolvers<void>();
  const ownerWrite = User.collection.updateOne.bind(User.collection);
  const attempts = { count: 0 };
  vi.spyOn(User.collection, 'updateOne').mockImplementation(async (...args) => {
    attempts.count += 1;
    const first = attempts.count === 1;
    try {
      const result = await ownerWrite(...args);
      if (first) {
        firstAdmitted.resolve();
        await releaseFirst.promise;
      }
      return result;
    } catch (error) {
      if (error instanceof mongoose.mongo.MongoServerError && error.code === 112) conflict.resolve();
      throw error;
    }
  });
  const complete = vi.fn(async () => ({ reply, model: 'fake-model', tokensUsed: 1 }));
  const first = triageEmail(triageDeps(complete), { email, analysis: {} });
  await firstAdmitted.promise;
  const second = triageEmail(triageDeps(complete), { email, analysis: {} });
  await conflict.promise;
  releaseFirst.resolve();
  expect(await first).toBe('created');
  expect(await second).toBe('duplicate');
  expect(attempts.count).toBeGreaterThan(2);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(await EmailTriageItemModel.countDocuments({ emailId: email.id })).toBe(1);
  expect((await EmailTriageItemModel.findOne({ emailId: email.id }).lean())?.summary).toBe('DELETED_EMAIL_SENTINEL');
});

it('lets handled and FYI sections progress while approvals block older email decisions', async () => {
  const cap = BRIEF_LIMITS.itemsPerSection;
  const rows = (kind: 'decision' | 'handled' | 'fyi', count: number, offset: number) =>
    Array.from({ length: count }, (_, index) => ({
      userId,
      emailId: `${kind}-${index}`,
      kind,
      summary: `${kind} ${index}`,
      createdAt: new Date(start.getTime() + offset + index),
    }));
  await EmailTriageItemModel.insertMany([
    ...rows('decision', 24, 0),
    ...rows('handled', cap + 1, 100),
    ...rows('fyi', cap + 1, 200),
    { ...rows('fyi', 1, 0)[0], emailId: 'foreign', userId: 'other-owner' },
    { ...rows('handled', 1, 0)[0], emailId: 'at-end', createdAt: end },
    { ...rows('fyi', 1, 0)[0], emailId: 'briefed', briefedAt: start },
  ]);
  const approvals: BriefApproval[] = Array.from({ length: cap }, (_, index) => ({
    questId: `quest-${index}`,
    sessionId: `session-${index}`,
    pendingActionTs: index,
    tool: 'approve',
    summary: '{}',
  }));
  async function next(waiting: BriefApproval[]) {
    const emails = await loadPendingBriefEmails(userId, end);
    const composed = assembleBrief('{"headline":"Brief"}', {
      periodStart: start,
      periodEnd: end,
      runs: [],
      approvals: waiting,
      questions: [],
      emails,
      delegations: [],
      reminders: [],
      obligations: [],
    });
    await emailTriageItemRepository.markBriefed(userId, briefedEmailIds(composed), end);
    return composed;
  }
  const first = await next(approvals);
  expect(first.decisions).toHaveLength(cap);
  expect(first.decisions.every(item => item.approval !== undefined)).toBe(true);
  expect(first.handled.map(item => item.source?.emailId)).toEqual(rows('handled', cap, 100).map(item => item.emailId));
  expect(first.happened.map(item => item.source?.emailId)).toEqual(rows('fyi', cap, 200).map(item => item.emailId));
  const second = await next(approvals);
  expect(second.handled.map(item => item.source?.emailId)).toEqual([`handled-${cap}`]);
  expect(second.happened.map(item => item.source?.emailId)).toEqual([`fyi-${cap}`]);
  const third = await next([]);
  expect(third.decisions.map(item => item.source?.emailId)).toEqual(rows('decision', cap, 0).map(item => item.emailId));
  expect(await EmailTriageItemModel.countDocuments({ kind: 'decision', briefedAt: null })).toBe(24 - cap);
  expect(await EmailTriageItemModel.countDocuments({ emailId: { $in: ['foreign', 'at-end'] }, briefedAt: null })).toBe(
    2
  );
});

it('adds the section index idempotently without replacing the original or unique indexes', async () => {
  const name = 'userId_1_briefedAt_1_kind_1_createdAt_1';
  await EmailTriageItemModel.collection.dropIndex(name);
  await sectionIndexMigration.up();
  await sectionIndexMigration.up();
  const indexes = await EmailTriageItemModel.collection.indexes();
  expect(indexes.find(index => index.name === name)?.key).toEqual({ userId: 1, briefedAt: 1, kind: 1, createdAt: 1 });
  expect(indexes.some(index => index.name === 'userId_1_briefedAt_1_createdAt_1')).toBe(true);
  expect(indexes.find(index => index.name === 'emailId_1')?.unique).toBe(true);
  await EmailTriageItemModel.insertMany(
    Array.from({ length: 200 }, (_, index) => ({
      userId,
      emailId: `backlog-${index}`,
      kind: 'decision',
      summary: 'Older',
    }))
  );
  const plan = z
    .object({
      queryPlanner: z.object({ winningPlan: z.unknown() }),
      executionStats: z.object({ totalDocsExamined: z.number() }),
    })
    .parse(
      await EmailTriageItemModel.find({ userId, briefedAt: null, kind: 'fyi', createdAt: { $lt: end } })
        .sort({ createdAt: 1 })
        .limit(BRIEF_LIMITS.itemsPerSection)
        .hint(name)
        .explain('executionStats')
    );
  expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(name);
  expect(plan.executionStats.totalDocsExamined).toBe(0);
});
