import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  mongoose,
  User,
  FeedbackModel,
  FeedbackTextModel,
  FeedbackNoteModel,
  FeedbackAiModel,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const captured = vi.hoisted(() => ({ handler: null as Handler | null }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    delete: (handler: Handler) => {
      captured.handler = handler;
    },
  }),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
await import('../delete');

let mongo: Awaited<ReturnType<typeof createMongoReplSet>>;
beforeAll(async () => {
  mongo = await createMongoReplSet();
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([
    User.collection.deleteMany({}),
    FeedbackModel.deleteMany({}),
    FeedbackTextModel.deleteMany({}),
    FeedbackNoteModel.deleteMany({}),
    FeedbackAiModel.deleteMany({}),
  ]);
});
const seed = async () => {
  const user = await User.create({ name: 'Reporter', username: 'reporter', email: 'reporter@example.test' });
  const report = await FeedbackModel.create({ userId: user.id, username: 'Reporter', status: 'New', type: 'Bug' });
  const expiresAt = new Date(Date.now() + 86400000);
  await FeedbackTextModel.create({ _id: report._id, content: 'Private report', contentTruncated: false, expiresAt });
  await FeedbackNoteModel.create({
    feedbackId: report.id,
    userId: user.id,
    author: { id: 'moderator', name: 'Moderator' },
    body: 'Private note',
    createdAt: new Date(),
    expiresAt,
  });
  await FeedbackAiModel.create({
    feedbackId: report.id,
    inputHash: 'hash',
    model: 'test-embedding',
    vector: [1],
    similar: [],
    reportCreatedAt: report.createdAt,
    expiresAt,
  });
  return { user, report };
};
const remove = async (userId: string, reportId: string) => {
  const { req, res } = createMocks({ method: 'DELETE', query: { id: reportId } });
  Object.assign(req, { user: { id: userId }, ability: { can: () => true }, logger: { error: vi.fn() } });
  if (!captured.handler) throw new Error('Expected feedback deletion handler');
  await captured.handler(req, res);
  return res;
};
describe('feedback deletion with AI children', () => {
  it('removes AI bytes and private notes with the actual report deletion route', async () => {
    const { user, report } = await seed();
    expect((await remove(user.id, report.id.toUpperCase()))._getStatusCode()).toBe(200);
    expect(await FeedbackModel.countDocuments()).toBe(0);
    expect(await FeedbackAiModel.countDocuments()).toBe(0);
    expect(await FeedbackNoteModel.countDocuments()).toBe(0);
    expect(await FeedbackTextModel.countDocuments()).toBe(0);
  });
  it('rolls the report and note deletes back when AI cleanup fails, then retries', async () => {
    const { user, report } = await seed();
    const failure = vi.spyOn(FeedbackAiModel, 'deleteMany').mockImplementationOnce(() => {
      throw new Error('AI cleanup failed');
    });
    try {
      await expect(remove(user.id, report.id)).rejects.toThrow('AI cleanup failed');
    } finally {
      failure.mockRestore();
    }
    expect(await FeedbackModel.countDocuments()).toBe(1);
    expect(await FeedbackAiModel.countDocuments()).toBe(1);
    expect(await FeedbackNoteModel.countDocuments()).toBe(1);
    expect(await FeedbackTextModel.countDocuments()).toBe(1);
    await remove(user.id, report.id);
    expect(await FeedbackAiModel.countDocuments()).toBe(0);
  });
});
