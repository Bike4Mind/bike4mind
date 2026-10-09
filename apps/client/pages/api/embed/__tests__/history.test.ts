import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks, type RequestMethod } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => Promise<void>;
const handlers = vi.hoisted(() => ({}) as Record<string, Handler>);
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      use: () => chain,
      get: (fn: Handler) => ((handlers.GET = fn), chain),
      delete: (fn: Handler) => ((handlers.DELETE = fn), chain),
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/embedCors', () => ({ embedCors: () => () => {} }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => {} }));

const mockVerifyEmbedSessionToken = vi.hoisted(() => vi.fn());
vi.mock('@server/embed/embedSessionToken', () => ({ verifyEmbedSessionToken: mockVerifyEmbedSessionToken }));

const mockVerifyEmbedKeyById = vi.hoisted(() => vi.fn());
vi.mock('@server/cli/auth', () => ({ verifyEmbedKeyById: mockVerifyEmbedKeyById }));

const mockReauthorize = vi.hoisted(() => vi.fn());
vi.mock('@server/embed/identifiedEmbedUser', () => ({ reauthorizeIdentifiedSession: mockReauthorize }));

const mockRepo = vi.hoisted(() => ({ getMessages: vi.fn(), deleteConversation: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ embedConversationRepository: mockRepo }));

import '../history';

const CLAIMS = {
  keyId: 'key-1',
  agentId: 'agent-1',
  organizationId: 'org-1',
  sessionId: 's',
  endUserId: 'host-user-1',
  oauthClientId: 'client-1',
};
const KEY_INFO = {
  keyId: 'key-1',
  agentId: 'agent-1',
  organizationId: 'org-1',
  allowedOrigins: ['https://host.example.com'],
  identifiedClientIds: ['client-1'],
};

async function call(method: RequestMethod, headers: Record<string, string> = { authorization: 'Bearer eyJ.tok' }) {
  const { req, res } = createMocks({ method, headers: { host: 'app.example.com', ...headers } });
  (req as unknown as { logger: object }).logger = { warn: vi.fn() };
  await handlers[method](req, res);
  return { status: res._getStatusCode(), body: res._getData() ? res._getJSONData() : undefined };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyEmbedSessionToken.mockReturnValue(CLAIMS);
  mockVerifyEmbedKeyById.mockResolvedValue(KEY_INFO);
  mockReauthorize.mockResolvedValue({ user: { id: 'host-user-1' } });
  mockRepo.getMessages.mockResolvedValue([{ role: 'user', content: 'hi', createdAt: new Date(0) }]);
});

describe('/api/embed/history', () => {
  it("returns the identified user's stored conversation with the bound agent", async () => {
    const { status, body } = await call('GET');
    expect(status).toBe(200);
    expect(mockRepo.getMessages).toHaveBeenCalledWith('host-user-1', 'agent-1');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi', createdAt: new Date(0).toISOString() }]);
  });

  it('erases the conversation on DELETE', async () => {
    const { status } = await call('DELETE');
    expect(status).toBe(204);
    expect(mockRepo.deleteConversation).toHaveBeenCalledWith('host-user-1', 'agent-1');
  });

  it('refuses an anonymous session token', async () => {
    mockVerifyEmbedSessionToken.mockReturnValue({ ...CLAIMS, endUserId: undefined, oauthClientId: undefined });
    const { status } = await call('GET');
    expect(status).toBe(403);
    expect(mockRepo.getMessages).not.toHaveBeenCalled();
  });

  it('refuses once the session is no longer authorized (grant revoked, client dropped)', async () => {
    mockReauthorize.mockResolvedValue({
      rejection: { status: 403, error: 'access_denied', error_description: 'User has not authorized this client' },
    });
    expect((await call('DELETE')).status).toBe(403);
    expect(mockReauthorize).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'host-user-1', clientId: 'client-1', allowedClientIds: ['client-1'] })
    );
    expect(mockRepo.deleteConversation).not.toHaveBeenCalled();
  });

  it('refuses a request with no token', async () => {
    expect((await call('GET', {})).status).toBe(401);
  });

  it('refuses a token whose key no longer backs it', async () => {
    mockVerifyEmbedKeyById.mockRejectedValue(new Error('Invalid embed key: revoked'));
    expect((await call('DELETE')).status).toBe(401);
    expect(mockRepo.deleteConversation).not.toHaveBeenCalled();
  });

  it('refuses an origin outside the key allow-list', async () => {
    const { status } = await call('GET', { authorization: 'Bearer eyJ.tok', origin: 'https://evil.example.com' });
    expect(status).toBe(403);
  });
});
