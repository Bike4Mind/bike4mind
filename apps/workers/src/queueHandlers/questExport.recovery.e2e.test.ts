import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { OrgFeedbackSummaryJob } from '@bike4mind/database';
import { ChatModels } from '@bike4mind/common';
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
vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({ dispatchWithLogger: (fn: unknown) => fn }));
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
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ download: async (key: string) => h.objects.get(key) }),
  getGeneratedImageStorage: () => ({ download: async (key: string) => h.objects.get(key) }),
}));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: h.progress }));
vi.mock('@bike4mind/services', () => ({ apiKeyService: { getEffectiveLLMApiKeys: async () => ({}) } }));
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
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
