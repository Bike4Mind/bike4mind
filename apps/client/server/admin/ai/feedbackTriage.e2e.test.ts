import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { AdminAiConfigSchema, FEEDBACK_AI_POLICY } from '@bike4mind/common';
import { FeedbackAiModel, FeedbackModel, FeedbackTextModel, AdminAiSuggestionModel, Cache } from '@bike4mind/database';
import { createMongoServer } from '../../../../../packages/database/src/__test__/createMongoServer';

const mocks = vi.hoisted(() => ({ config: vi.fn(), embed: vi.fn(), decide: vi.fn() }));
vi.mock('./embedAdminAi', () => ({ loadFeedbackAiConfig: mocks.config, embedAdminAi: mocks.embed }));
vi.mock('@server/decisions/platformDecision', () => ({
  callablePlatformModel: async () => 'jev/decision',
  resolveJsonInput: vi.fn(),
  decisionFailureCode: () => undefined,
  toMicroUsd: (n: number) => Math.ceil(n * 1_000_000),
}));
vi.mock('@server/decisions/executeDecision', () => ({ executeDecision: mocks.decide }));
import { triageFeedback } from './feedbackTriage';

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri());
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
  ]);
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
  mocks.embed.mockResolvedValue({ ok: true, vector: [1, 0], model: 'text-embedding-3-small', costUsd: 0.0001 });
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
  const doc = await FeedbackModel.create({
    userId: 'reporter',
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
});
