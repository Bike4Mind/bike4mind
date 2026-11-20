// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

vi.mock('@bike4mind/server-utils/integrations/slack/slackExportErrors', () => ({
  isSlackUserValidationError: () => false,
  isSlackUserValidationErrorByMessage: () => false,
  createSlackExportError: (message: string) => new Error(message),
}));

import '../channel';

const body = { workspaceId: 'ws1', channelId: 'C1', includeThreads: false, includeUserNames: false };

const slack = (payloads: Record<string, unknown>) =>
  vi.fn(async (url: string) => {
    const method = new URL(url).pathname.split('/').pop() as string;
    return { ok: true, status: 200, json: async () => payloads[method], headers: new Headers() };
  });

describe('slack channel download audit row', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(m => m.mockReset());
    mocks.findByIdWithToken.mockResolvedValue({ isActive: true, slackBotToken: 'enc' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records the export when the file is sent', async () => {
    vi.stubGlobal(
      'fetch',
      slack({
        'conversations.history': { ok: true, messages: [{ ts: '1', text: 'hi', user: 'U1' }] },
        'conversations.info': { ok: true, channel: { name: 'general' } },
      })
    );
    const res = await callPost(body);
    expect(res.statusCode).toBe(200);
    expect(res._getHeaders()['content-type']).toBe('application/json');
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'integration.slack_channel.exported',
        target: expect.objectContaining({ id: 'C1' }),
        details: expect.objectContaining({ mode: 'download', status: 'complete', messageCount: 1 }),
      })
    );
  });

  it('writes no audit row when the workspace is inactive', async () => {
    mocks.findByIdWithToken.mockResolvedValue({ isActive: false });
    await expect(callPost(body)).rejects.toThrow();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
