import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  AssistantBriefModel,
  DelegatedItemModel,
  assistantBriefRepository,
  delegatedItemRepository,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { composeBrief, type BriefComposeDeps } from './briefCompose';
import { DelegationClaimBusyError, processDelegation, type DelegationProcessDeps } from './delegationProcess';
import { loadPendingBriefDelegations } from './loadPendingBriefDelegations';
import indexMigration from '../../../../packages/scripts/migrate/migrations/20261119042525_ensure-delegated-item-indexes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoReplSet>>;
const userId = new mongoose.Types.ObjectId().toString();
const start = new Date('2026-11-01T00:00:00Z');
const end = new Date('2026-11-19T12:00:00Z');
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  await DelegatedItemModel.collection.deleteMany({});
  await AssistantBriefModel.collection.deleteMany({});
});

const createItem = async (intent: string, createdAt = new Date(end.getTime() - 60_000)) => {
  const { insertedId } = await DelegatedItemModel.collection.insertOne({
    userId,
    intent,
    url: null,
    text: 'shared words',
    fileIds: [],
    status: 'pending',
    result: null,
    failureReason: null,
    model: null,
    settledAt: null,
    claimedUntil: null,
    briefedAt: null,
    createdAt,
    updatedAt: createdAt,
  });
  return insertedId.toString();
};

function processDeps(complete: DelegationProcessDeps['complete']): DelegationProcessDeps {
  return {
    now: () => end,
    items: delegatedItemRepository,
    canRun: async () => 'ok',
    fetchPage: async () => '',
    findFile: async () => null,
    fileText: async () => '',
    complete,
    logger,
  };
}

async function composeNextBrief(complete: BriefComposeDeps['complete'] = async () => '{"headline":"Your brief"}') {
  const brief = await assistantBriefRepository.createComposing({ userId, periodStart: start, periodEnd: end });
  await composeBrief(
    {
      now: () => end,
      users: { findById: async () => ({ id: userId }) },
      briefs: assistantBriefRepository,
      loadActivity: async (_brief, now) => ({
        periodStart: start,
        periodEnd: end,
        runs: [],
        approvals: [],
        questions: [],
        emails: [],
        reminders: [],
        delegations: (await loadPendingBriefDelegations(userId, end, now)).map(item => ({
          delegationId: item._id.toString(),
          intent: item.intent,
          status: item.status,
          result: item.result,
        })),
        obligations: [],
      }),
      canCompose: async () => 'ok',
      complete,
      push: async () => undefined,
      emails: { markBriefed: async () => 0, storedEmailIds: async () => [] },
      delegations: delegatedItemRepository,
      logger,
    },
    { briefId: brief._id.toString(), userId }
  );
  return AssistantBriefModel.findById(brief._id).lean().orFail();
}

it('runs the model once when the same event is delivered twice at once', async () => {
  const id = await createItem('Summarize');
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const recordUsage = vi.fn(async () => undefined);
  const complete = vi.fn<DelegationProcessDeps['complete']>(async () => {
    started.resolve();
    await release.promise;
    return { reply: '{"outcome":"handled","result":"Summary."}', model: 'fake-model', recordUsage };
  });
  const first = processDelegation(processDeps(complete), { delegationId: id, userId });
  await started.promise;
  try {
    await expect(processDelegation(processDeps(complete), { delegationId: id, userId })).rejects.toBeInstanceOf(
      DelegationClaimBusyError
    );
  } finally {
    release.resolve();
    await first;
  }

  expect(complete).toHaveBeenCalledOnce();
  expect(recordUsage).toHaveBeenCalledOnce();
  expect(await delegatedItemRepository.findById(id)).toMatchObject({ status: 'handled', result: 'Summary.' });
});

it('carries a pending item until it settles, then its outcome exactly once', async () => {
  const id = await createItem('Summarize');

  const first = await composeNextBrief();
  expect(first.happened).toMatchObject([{ text: 'Working on: "Summarize"', source: { delegationId: id } }]);
  expect((await delegatedItemRepository.findById(id))?.briefedAt).toBeNull();

  const reply = '{"outcome":"needs_decision","result":"Approve the quote?"}';
  const recordUsage = vi.fn(async () => undefined);
  await processDelegation(
    processDeps(async () => ({ reply, model: 'fake-model', recordUsage })),
    { delegationId: id, userId }
  );

  expect(recordUsage).toHaveBeenCalledOnce();

  const failed = await composeNextBrief(async () => 'not json');
  expect(failed.status).toBe('failed');
  expect((await delegatedItemRepository.findById(id))?.briefedAt).toBeNull();

  const second = await composeNextBrief();
  expect(second.decisions).toMatchObject([{ text: 'Approve the quote?', source: { delegationId: id } }]);
  expect((await delegatedItemRepository.findById(id))?.briefedAt).toEqual(end);

  const third = await composeNextBrief();
  expect([...third.happened, ...third.handled, ...third.decisions]).toEqual([]);
});

it('times out an item pending for over an hour and reports it as not finished', async () => {
  const id = await createItem('Book the venue', new Date(end.getTime() - 2 * 60 * 60 * 1000));

  const brief = await composeNextBrief();

  expect(brief.happened).toMatchObject([{ text: 'Could not finish: "Book the venue"', source: { delegationId: id } }]);
  expect(await delegatedItemRepository.findById(id)).toMatchObject({ status: 'failed', failureReason: 'timed_out' });
});

it('creates the brief and stale-sweep indexes idempotently', async () => {
  await DelegatedItemModel.createCollection();
  await indexMigration.up();
  await indexMigration.up();
  await indexMigration.down();
  const names = (await DelegatedItemModel.collection.indexes()).map(index => index.name);
  expect(names).toEqual(expect.arrayContaining(['userId_1_briefedAt_1_createdAt_1', 'userId_1_status_1_createdAt_1']));
});
