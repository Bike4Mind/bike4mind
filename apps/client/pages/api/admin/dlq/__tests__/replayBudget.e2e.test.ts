// @vitest-environment node
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import DlqReplayLogModel, {
  dlqReplayLogRepository,
} from '../../../../../../../packages/database/src/models/infra/webhooks/DlqReplayLogModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const h = vi.hoisted(() => ({
  post: undefined as ((req: unknown, res: unknown) => Promise<unknown>) | undefined,
  receive: vi.fn(),
  send: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => ({
    post: (handler: typeof h.post) => {
      h.post = handler;
      return handler;
    },
  }),
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  ApiKeyScope: { ADMIN: 'admin' },
}));
vi.mock('@bike4mind/database', async () => ({
  dlqReplayLogRepository: (
    await import('../../../../../../../packages/database/src/models/infra/webhooks/DlqReplayLogModel')
  ).dlqReplayLogRepository,
}));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getDlqByLabel: () => ({ label: 'quest', displayName: 'Quest queue', sourceQueue: 'questQueue' }),
  getDlqUrl: () => 'dlq-url',
  getSourceQueueUrl: () => 'source-url',
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({
  receiveFromQueue: h.receive,
  sendToQueue: h.send,
  deleteFromQueue: h.delete,
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn() }));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import '../replay';

let mongoServer: MongoMemoryServer;
beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});
beforeEach(async () => {
  await DlqReplayLogModel.deleteMany({});
  vi.clearAllMocks();
  h.receive.mockResolvedValue([{ MessageId: 'budget-message', ReceiptHandle: 'receipt-1', Body: '{}' }]);
  h.send.mockResolvedValue(undefined);
  h.delete.mockResolvedValue(undefined);
});

const attempt = {
  queueLabel: 'quest',
  messageId: 'budget-message',
  messageBody: '{}',
  sourceQueue: 'Quest queue',
  replayedBy: 'admin-1',
};

async function callReplay(mode: 'direct' | 'batch') {
  const { req, res } = createMocks({
    method: 'POST',
    body: {
      queueLabel: 'quest',
      reason: 'Verify persisted replay budget',
      ...(mode === 'direct'
        ? { messages: [{ messageId: attempt.messageId, receiptHandle: 'receipt-1', body: '{}' }] }
        : { batchSize: 1 }),
    },
  });
  (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await h.post!(req, res);
  return JSON.parse(res._getData()) as { replayed: number; skipped: number };
}

describe('replay budget with persisted discard history', () => {
  it.each(['direct', 'batch'] as const)('allows %s replay after three failed discards', async mode => {
    for (let index = 0; index < 3; index++) {
      const pending = await dlqReplayLogRepository.logReplay({ ...attempt, operation: 'discard', status: 'pending' });
      await dlqReplayLogRepository.finalizeDiscard(pending.id, 'failed', 'expired receipt');
    }
    expect(await callReplay(mode)).toMatchObject({ replayed: 1, skipped: 0 });
    expect(h.send).toHaveBeenCalledOnce();
    expect(await dlqReplayLogRepository.countAttempts(attempt.messageId)).toBe(1);
  });

  it.each(['direct', 'batch'] as const)('still blocks %s replay after three genuine replay failures', async mode => {
    for (let index = 0; index < 3; index++) {
      await dlqReplayLogRepository.logReplay({ ...attempt, status: 'failed' });
    }
    expect(await callReplay(mode)).toMatchObject({ replayed: 0, skipped: 1 });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.delete).not.toHaveBeenCalled();
  });
});
