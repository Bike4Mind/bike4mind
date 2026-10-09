import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import yauzl from 'yauzl';
import { randomUUID } from 'crypto';
import { QuestMasterPlan, Quest, Session, User, FabFile, OrgFeedbackSummaryJob } from '@bike4mind/database';
import { KnowledgeType, ChatModels } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const h = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  upload: vi.fn(),
  progress: vi.fn(),
  complete: vi.fn(),
  models: vi.fn(),
  report: vi.fn(),
}));
vi.mock('@server/queueHandlers/utils', () => ({ dispatchWithLogger: (fn: unknown) => fn }));
vi.mock('sst', () => ({
  Resource: { appFilesBucket: { name: 'test' }, websocket: { managementEndpoint: 'http://test' } },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    getMetadata = async (key: string) => {
      if (!h.objects.has(key)) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return {};
    };
    upload = h.upload;
    getSignedUrl = async (key: string) => `http://download.test/${key}`;
  },
}));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ download: async (key: string) => h.objects.get(key) }),
  getGeneratedImageStorage: () => ({ download: async (key: string) => h.objects.get(key) }),
}));
vi.mock('@server/websocket/utils', () => ({ sendToClient: h.progress }));
vi.mock('@bike4mind/services', () => ({ apiKeyService: { getEffectiveLLMApiKeys: async () => ({}) } }));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: h.models,
  getLlmByModel: () => ({ complete: h.complete }),
}));
vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  orgFeedbackReport: h.report,
}));
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findMemberUserIds: async () => ({ userIds: [], aclOnly: [], stampOnly: [] }) },
}));
import { dispatch } from './questExport';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };
const run = (payload: unknown) =>
  dispatch(
    { Records: [{ body: JSON.stringify(payload) }] } as never,
    { getRemainingTimeInMillis: () => 600000 } as never,
    logger as never
  );
let mongo: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri());
  await OrgFeedbackSummaryJob.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.clearAllMocks();
  h.objects.clear();
  h.models.mockResolvedValue([]);
  h.upload.mockImplementation(async (body: Buffer | string, key: string) => {
    h.objects.set(key, Buffer.from(body));
  });
  h.progress.mockResolvedValue(undefined);
  h.complete.mockImplementation(async (_model, _messages, _options, onText) => {
    await onText(['Controlled summary']);
  });
  h.report.mockResolvedValue({
    range: { from: '2026-01-01', to: '2026-01-02' },
    totals: { count: 1 },
    byType: [],
    byStatus: [],
    bySubject: [],
    byTag: [],
    byDay: [],
  });
});
const seed = async () => {
  const owner = new mongoose.Types.ObjectId();
  const stranger = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: owner, username: `export-${owner}`, email: `${owner}@example.invalid` });
  const session = await Session.create({
    userId: String(owner),
    name: 'Export',
    firstCreated: new Date(),
    lastUpdated: new Date(),
  });
  const other = await Session.create({
    userId: String(stranger),
    name: 'Unrelated',
    firstCreated: new Date(),
    lastUpdated: new Date(),
  });
  const image = await FabFile.create({
    userId: String(owner),
    fileName: 'figure.png',
    filePath: `figure-${owner}.png`,
    type: KnowledgeType.FILE,
    mimeType: 'image/png',
    moderationStatus: 'clean',
  });
  const denied = await FabFile.create({
    userId: String(stranger),
    fileName: 'denied.png',
    filePath: `denied-${owner}.png`,
    type: KnowledgeType.FILE,
    mimeType: 'image/png',
    moderationStatus: 'clean',
  });
  h.objects.set(image.filePath, Buffer.from('allowed image'));
  h.objects.set(denied.filePath, Buffer.from('excluded image'));
  const quest = new mongoose.Types.ObjectId();
  const hidden = new mongoose.Types.ObjectId();
  await Quest.collection.insertMany([
    {
      _id: quest,
      userId: String(owner),
      sessionId: session.id,
      reply: `Visible answer ![allowed](https://files.s3.amazonaws.com/${image.filePath}) ![denied](https://files.s3.amazonaws.com/${denied.filePath})`,
    },
    { _id: hidden, userId: String(stranger), sessionId: other.id, reply: 'Excluded answer' },
  ]);
  const plan = await QuestMasterPlan.create({
    notebookId: session.id,
    userId: String(owner),
    goal: 'Export fixture',
    quests: [
      {
        id: 'q',
        title: 'Work',
        description: 'Description',
        complexity: 'simple',
        subQuests: [quest, hidden].map((id, i) => ({
          id: String(i),
          title: `Task ${i}`,
          status: 'completed',
          questId: String(id),
        })),
      },
    ],
  });
  return { plan, payload: { exportJobId: randomUUID(), planId: plan.id, userId: String(owner) } };
};
async function extractZipEntries(zipBuffer: Buffer): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();

  const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(err ?? new Error('No zipfile'));
      resolve(zf);
    });
  });

  return new Promise((resolve, reject) => {
    zipfile.on('error', reject);
    zipfile.on('end', () => resolve(entries));
    zipfile.readEntry();

    zipfile.on('entry', (entry: yauzl.Entry) => {
      zipfile.openReadStream(entry, (err, stream) => {
        if (err || !stream) return reject(err ?? new Error('No stream'));
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          entries.set(entry.fileName, Buffer.concat(chunks));
          zipfile.readEntry();
        });
        stream.on('error', reject);
      });
    });
  });
}

it('creates an actual ZIP with permitted markdown and image bytes, excluding unrelated data', async () => {
  const { payload } = await seed();
  await run(payload);
  const [body, key] = h.upload.mock.calls[0];
  const entries = await extractZipEntries(body);
  const markdown = entries.get('export-fixture.md')!.toString();
  expect(markdown).toContain('Visible answer');
  expect(markdown).not.toContain('Excluded answer');
  expect(entries.get('images/fig-1.png')!.toString()).toBe('allowed image');
  expect([...entries.values()].some(value => value.toString().includes('excluded image'))).toBe(false);
  expect(entries.size).toBe(2);
  expect(h.progress).toHaveBeenLastCalledWith(
    payload.userId,
    'http://test',
    expect.objectContaining({ status: 'completed', downloadUrl: `http://download.test/${key}`, droppedQuestCount: 1 })
  );
});
it('replays the committed artifact after a notification failure without another upload or model pass', async () => {
  const { plan, payload } = await seed();
  h.progress.mockImplementation(async (_user, _endpoint, frame) => {
    if (frame.status === 'completed') throw new Error('notification unavailable');
  });
  await expect(run(payload)).rejects.toThrow('notification unavailable');
  const key = h.upload.mock.calls[0][1];
  await QuestMasterPlan.updateOne({ _id: plan._id }, { goal: 'Changed goal' });
  h.progress.mockResolvedValue(undefined);
  await run(payload);
  expect(h.upload).toHaveBeenCalledTimes(1);
  expect(h.models).toHaveBeenCalledTimes(1);
  expect(h.progress).toHaveBeenLastCalledWith(
    payload.userId,
    'http://test',
    expect.objectContaining({ downloadUrl: `http://download.test/${key}` })
  );
});
it('retains storage failure for retry and rechecks plan access before artifact replay', async () => {
  const { plan, payload } = await seed();
  h.upload.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(run(payload)).rejects.toThrow('storage unavailable');
  await run(payload);
  expect(h.upload).toHaveBeenCalledTimes(2);
  await QuestMasterPlan.updateOne({ _id: plan._id }, { userId: 'different-owner' });
  await expect(run(payload)).rejects.toThrow('Access denied');
  expect(h.upload).toHaveBeenCalledTimes(2);
});
it('routes organization summary through durable completion, releases its hold and does not repay on replay', async () => {
  const summaryJobId = randomUUID();
  const organizationId = randomUUID();
  await OrgFeedbackSummaryJob.create({
    summaryJobId,
    organizationId,
    requestedBy: 'requester',
    startDate: new Date('2026-01-01'),
    endDate: new Date('2026-01-02'),
    status: 'pending',
    activeKey: 'active',
  });
  h.models.mockResolvedValue([{ id: ChatModels.CLAUDE_4_5_HAIKU_BEDROCK }]);
  const payload = {
    jobType: 'orgFeedbackSummary',
    summaryJobId,
    organizationId,
    userId: 'requester',
    startDate: '2026-01-01',
    endDate: '2026-01-02',
  };
  h.complete.mockRejectedValueOnce(new Error('provider unavailable'));
  await expect(run(payload)).rejects.toThrow('provider unavailable');
  expect(await OrgFeedbackSummaryJob.findOne({ summaryJobId }).lean()).toMatchObject({
    status: 'failed',
    activeKey: summaryJobId,
  });
  await run(payload);
  const completed = await OrgFeedbackSummaryJob.findOne({ summaryJobId }).lean();
  expect(completed).toMatchObject({ status: 'completed', activeKey: summaryJobId });
  expect(h.objects.has(completed!.s3Key!)).toBe(true);
  h.progress.mockRejectedValueOnce(new Error('notification unavailable'));
  await expect(run(payload)).rejects.toThrow('notification unavailable');
  await run(payload);
  expect(h.complete).toHaveBeenCalledTimes(2);
  expect(h.upload).toHaveBeenCalledTimes(1);
  expect((await OrgFeedbackSummaryJob.findOne({ summaryJobId }))!.status).toBe('completed');
});
