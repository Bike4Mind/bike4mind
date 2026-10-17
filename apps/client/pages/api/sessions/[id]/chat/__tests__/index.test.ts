import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET/POST /api/sessions/[id]/chat: both return chat messages through chatMessageResponseSchema,
 * which withholds server-only keys (embedding, slackNotification, callback) and drops anything
 * undeclared. The session manager is mocked, so these pin only the route's response boundary.
 */

type RouteHandler = (req: unknown, res: unknown) => unknown;

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | RouteHandler,
  postHandler: null as null | RouteHandler,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, (fn: RouteHandler) => unknown> = {
    use: () => chain,
    patch: () => chain,
    delete: () => chain,
    get: fn => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: fn => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: RouteHandler) => fn,
}));

const getMessagesFromSession = vi.hoisted(() => vi.fn());
const addMessageToSession = vi.hoisted(() => vi.fn());
vi.mock('@server/managers/sessionManager', () => ({ getMessagesFromSession, addMessageToSession }));

import '@pages/api/sessions/[id]/chat/index';

const SERVER_ONLY_KEYS = ['embedding', 'slackNotification', 'callback', '__v'];

const storedMessage = () => ({
  id: 'quest-1',
  sessionId: 'sess-1',
  prompt: 'hello',
  reply: 'hi there',
  embedding: [0.1, 0.2, 0.3],
  slackNotification: { channel: 'C123', threadTs: '1.2' },
  callback: { url: 'https://hook.example.test', apiKeyId: 'key-1' },
  __v: 5,
});

const expectStripped = (message: Record<string, unknown>) => {
  for (const key of SERVER_ONLY_KEYS) expect(message).not.toHaveProperty(key);
  expect(message).toMatchObject({ id: 'quest-1', prompt: 'hello', reply: 'hi there' });
};

const call = (method: 'GET' | 'POST', body?: object) => {
  const { req, res } = createMocks({ method, query: { id: 'sess-1' }, body });
  Object.assign(req, { user: { id: 'user-1' }, ability: {} });
  const handler = method === 'GET' ? mockRefs.getHandler! : mockRefs.postHandler!;
  return { res, promise: handler(req, res) };
};

describe('/api/sessions/[id]/chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET withholds server-only and undeclared keys from every message in the page', async () => {
    getMessagesFromSession.mockResolvedValue({ data: [storedMessage()], hasMore: false });
    const { res, promise } = call('GET');
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.hasMore).toBe(false);
    expect(body.data).toHaveLength(1);
    expectStripped(body.data[0]);
  });

  it('POST withholds server-only and undeclared keys from the created message', async () => {
    addMessageToSession.mockResolvedValue({ toJSON: () => storedMessage() });
    const { res, promise } = call('POST', {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'message',
      prompt: 'hello',
    });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expectStripped(res._getJSONData());
  });
});
