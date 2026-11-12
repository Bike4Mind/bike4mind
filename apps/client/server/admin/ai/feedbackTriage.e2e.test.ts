import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { AdminAiConfigSchema, FEEDBACK_AI_POLICY, OpenAIEmbeddingModel } from '@bike4mind/common';
import {
  FeedbackAiModel,
  FeedbackModel,
  FeedbackTextModel,
  AdminAiSuggestionModel,
  AdminAiAttemptModel,
  User,
  Cache,
  withTransaction,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import type { embedAdminAi, loadFeedbackAiConfig } from './embedAdminAi';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
type DecisionCall = { body: { questions: { name: string; type: string }[] } };
type DecisionResult = { response: { answers: unknown[] } };

const mocks = vi.hoisted(() => ({
  config: vi.fn<typeof loadFeedbackAiConfig>(),
  embed: vi.fn<typeof embedAdminAi>(),
  decide: vi.fn<(call: DecisionCall) => Promise<DecisionResult>>(),
}));
vi.mock('./embedAdminAi', () => ({ loadFeedbackAiConfig: mocks.config, embedAdminAi: mocks.embed }));
vi.mock('@server/decisions/platformDecision', () => ({
  callablePlatformModel: async () => 'jev/decision',
  resolveJsonInput: vi.fn(),
  decisionFailureCode: () => undefined,
  toMicroUsd: (n: number) => Math.ceil(n * 1_000_000),
}));
vi.mock('@server/decisions/executeDecision', () => ({ executeDecision: mocks.decide }));
import { triageFeedback } from './feedbackTriage';

let mongo: MongoMemoryReplSet;
beforeAll(async () => {
  mongo = await createMongoReplSet();
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await Cache.syncIndexes();
  await FeedbackAiModel.syncIndexes();
  await AdminAiSuggestionModel.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
afterEach(async () => {
  await Promise.all([
    FeedbackModel.deleteMany({}),
    FeedbackTextModel.deleteMany({}),
    FeedbackAiModel.deleteMany({}),
    AdminAiSuggestionModel.deleteMany({}),
    Cache.deleteMany({}),
    AdminAiAttemptModel.deleteMany({}),
    User.collection.deleteMany({}),
  ]);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const setup = () => {
  mocks.config.mockResolvedValue(
    AdminAiConfigSchema.parse({
      enabled: true,
      monthlyCapUsd: 10,
      features: { feedbackTriage: { mode: 'shadow', dailyBudgetUsd: 1, maxCallsPerDay: 100 } },
    })
  );
  mocks.embed.mockResolvedValue({
    ok: true,
    vector: [1, 0],
    model: OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL,
    costUsd: 0.0001,
  });
  mocks.decide.mockImplementation(async ({ body }) => {
    const q = body.questions[0];
    const value = q.name === 'area' ? 'chat' : q.name === 'severity' ? 'major' : 'candidate_0';
    return {
      response: {
        answers: [
          q.type === 'predicate'
            ? { type: 'predicate', name: q.name, probability: 0.9 }
            : {
                type: 'choice',
                name: q.name,
                choice: value,
                probabilities: [{ value, probability: 0.9 }],
                confidence: 0.9,
              },
        ],
      },
    };
  });
};
const report = async (content = 'Chat fails for jane@example.com account 64b7f0c2a1b2c3d4e5f60718') => {
  const reporterId = new mongoose.Types.ObjectId();
  const reporter = await User.create({
    username: `reporter-${reporterId}`,
    email: `reporter-${reporterId}@example.test`,
    name: 'Reporter',
  });
  const doc = await FeedbackModel.create({
    userId: reporter.id,
    username: 'Reporter',
    status: 'New',
    subject: 'product',
    type: 'Bug',
  });
  await FeedbackTextModel.create({
    _id: doc._id,
    content,
    contentTruncated: false,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return doc;
};
describe('feedback triage persistence', () => {
  it('does not reuse an expired suggestion after a text revision', async () => {
    setup();
    const doc = await report();
    await triageFeedback(doc.id);
    const first = await FeedbackAiModel.findOne({ feedbackId: doc.id });
    await FeedbackTextModel.updateOne({ _id: doc._id }, { $inc: { revision: 1 } });
    await FeedbackAiModel.deleteOne({ feedbackId: doc.id });
    await triageFeedback(doc.id);
    expect((await FeedbackAiModel.findOne({ feedbackId: doc.id }))?.suggestionId).not.toBe(first?.suggestionId);
  });
  it('observes a kill switch changed after embedding before decision work', async () => {
    setup();
    const initial = await mocks.config();
    mocks.config.mockResolvedValue(AdminAiConfigSchema.parse({})).mockResolvedValueOnce(initial);
    const doc = await report();
    await triageFeedback(doc.id);
    expect(mocks.embed).toHaveBeenCalledOnce();
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(await FeedbackAiModel.countDocuments()).toBe(0);
  });
  it('stores labels, redacts decision evidence, deduplicates unchanged runs and leaves status alone', async () => {
    setup();
    const doc = await report();
    await triageFeedback(doc.id);
    const row = await FeedbackAiModel.findOne({ feedbackId: doc.id }).lean();
    expect(row?.expiresAt).toEqual((await FeedbackTextModel.findById(doc.id))?.expiresAt);
    expect(row?.labels).toMatchObject({ area: 'chat', severity: 'major', actionable: true, duplicateId: null });
    expect(JSON.stringify(mocks.decide.mock.calls)).not.toContain('jane@example.com');
    expect(JSON.stringify(mocks.decide.mock.calls)).not.toContain('64b7f0c2a1b2c3d4e5f60718');
    await triageFeedback(doc.id);
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(mocks.decide).toHaveBeenCalledTimes(4);
    expect((await FeedbackModel.findById(doc.id))?.status).toBe('New');
  });
  it('selects only retained earlier reports and resolves the model alias server-side', async () => {
    setup();
    const earlier = await report('Chat fails');
    await triageFeedback(earlier.id);
    const doc = await report('Chat fails again');
    await triageFeedback(doc.id);
    expect((await FeedbackAiModel.findOne({ feedbackId: doc.id }))?.labels?.duplicateId).toBe(earlier.id);
    const stored = await AdminAiSuggestionModel.findOne({ entityId: doc.id });
    expect(stored?.policyVersion).toBe(FEEDBACK_AI_POLICY);
    expect(JSON.stringify(mocks.decide.mock.calls)).not.toContain(earlier.id);
  });
  it('preserves the manual queue on disabled, embedding or decision failure', async () => {
    setup();
    const doc = await report();
    mocks.config.mockResolvedValueOnce(AdminAiConfigSchema.parse({}));
    await triageFeedback(doc.id);
    expect(mocks.embed).not.toHaveBeenCalled();
    mocks.embed.mockResolvedValueOnce({ ok: false, skip: 'budget' });
    await triageFeedback(doc.id);
    expect(mocks.decide).not.toHaveBeenCalled();
    mocks.decide.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(triageFeedback(doc.id)).resolves.toBeUndefined();
    expect(await FeedbackAiModel.countDocuments()).toBe(0);
    expect((await FeedbackModel.findById(doc.id))?.status).toBe('New');
  });
  it('refuses final persistence after the reporter enters permanent purge', async () => {
    setup();
    const doc = await report();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const decide = mocks.decide.getMockImplementation();
    if (!decide) throw new Error('Expected decision fixture');
    mocks.decide.mockImplementationOnce(async call => {
      entered.resolve();
      await release.promise;
      return decide(call);
    });
    const pending = triageFeedback(doc.id);
    await entered.promise;
    try {
      await User.updateOne({ _id: doc.userId }, { $set: { 'deletion.purgeStartedAt': new Date() } });
    } finally {
      release.resolve();
      await pending;
    }
    expect(await FeedbackAiModel.countDocuments({ feedbackId: doc.id })).toBe(0);
    expect((await FeedbackModel.findById(doc.id))?.status).toBe('New');
  });

  it('orders deletion against the final AI upsert instead of recreating an orphan', async () => {
    setup();
    const doc = await report();
    const deletionStarted = Promise.withResolvers<void>();
    const requestDeletion = Promise.withResolvers<void>();
    const state = { requested: false };
    // Register this continuation outside triage's async transaction context.
    const deletion = (async () => {
      await requestDeletion.promise;
      await withTransaction(async () => {
        await FeedbackModel.deleteOne({ _id: doc._id });
        await FeedbackAiModel.deleteMany({ feedbackId: doc.id });
      });
    })();
    const settledDeletion = Promise.allSettled([deletion]);
    const realDelete = FeedbackModel.deleteOne.bind(FeedbackModel);
    vi.spyOn(FeedbackModel, 'deleteOne').mockImplementationOnce((filter, options) => {
      const query = realDelete(filter, options);
      return query.pre(() => {
        deletionStarted.resolve();
      });
    });
    const realUpsert = FeedbackAiModel.updateOne.bind(FeedbackAiModel);
    const upsert = vi.spyOn(FeedbackAiModel, 'updateOne').mockImplementationOnce((filter, update, options) => {
      const query = realUpsert(filter, update, options);
      return query.pre(async () => {
        state.requested = true;
        requestDeletion.resolve();
        await deletionStarted.promise;
        // Without a parent fence deletion can commit in the check-to-upsert gap. A fenced
        // writer holds the parent, so finish its write before awaiting that deletion.
        if (!query.getOptions().session) await deletion;
      });
    });
    try {
      await triageFeedback(doc.id);
      expect(upsert).toHaveBeenCalledOnce();
      expect(state.requested).toBe(true);
      await deletion;
      expect(await FeedbackModel.countDocuments({ _id: doc._id })).toBe(0);
      expect(await FeedbackAiModel.countDocuments({ feedbackId: doc.id })).toBe(0);
    } finally {
      requestDeletion.resolve();
      await settledDeletion;
    }
  });
});
