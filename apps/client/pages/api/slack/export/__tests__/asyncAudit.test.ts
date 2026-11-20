// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;
type Middleware = (req: unknown, res: unknown, next: () => void) => void;

const captured = vi.hoisted(() => ({ middlewares: [] as Middleware[], handlers: {} as Record<string, Handler> }));
const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  findByIdWithToken: vi.fn(),
  findActiveByUserId: vi.fn(),
  createJob: vi.fn(),
  markFailed: vi.fn(),
  sendToQueue: vi.fn(),
}));

// Keeps the real adminApi permission gate: it runs as a captured middleware ahead of the handler.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      use(fn: Middleware) {
        captured.middlewares.push(fn);
        return this;
      },
      post(fn: Handler) {
        captured.handlers.POST = fn;
        return this;
      },
      get() {
        return this;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: mocks.audit }));
vi.mock('@bike4mind/database', () => ({
  slackDevWorkspaceRepository: { findByIdWithToken: mocks.findByIdWithToken },
  slackExportJobRepository: {
    findActiveByUserId: mocks.findActiveByUserId,
    create: mocks.createJob,
    markFailed: mocks.markFailed,
  },
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendToQueue: mocks.sendToQueue }));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({ getSourceQueueUrl: () => 'queue-url' }));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({ decryptToken: () => 'xoxb-token' }));

const callPost = async (body: unknown) => {
  const { req, res } = createMocks({ method: 'POST', body: body as never });
  Object.assign(req, { user: { id: 'admin1', isAdmin: true }, logger: { error: vi.fn() } });
  for (const middleware of captured.middlewares) middleware(req, res, () => undefined);
  await captured.handlers.POST(req, res);
  return res;
};

import '../async';

const body = { workspaceId: 'ws1', channelId: 'C1', includeThreads: false, includeUserNames: false };

describe('async slack export audit row', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(m => m.mockReset());
    mocks.findByIdWithToken.mockResolvedValue({ isActive: true, slackBotToken: 'enc' });
    mocks.findActiveByUserId.mockResolvedValue(null);
    mocks.createJob.mockResolvedValue({ id: 'job1' });
  });

  it('records the queued export', async () => {
    const res = await callPost(body);
    expect(res._getJSONData()).toMatchObject({ jobId: 'job1', status: 'pending' });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'integration.slack_channel.exported',
        target: expect.objectContaining({ id: 'C1' }),
        details: expect.objectContaining({ mode: 'queued', jobId: 'job1' }),
      })
    );
  });

  it('writes no audit row when the job cannot be queued', async () => {
    mocks.sendToQueue.mockRejectedValue(new Error('sqs down'));
    await expect(callPost(body)).rejects.toThrow('Failed to start export');
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('writes no audit row for an invalid request', async () => {
    await expect(callPost({ workspaceId: 'ws1' })).rejects.toThrow();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
