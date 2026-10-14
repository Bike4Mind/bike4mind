import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import jwt from 'jsonwebtoken';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = { use: () => chain, post: (fn: unknown) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => {} }));
vi.mock('@server/middlewares/embedCors', () => ({ embedCors: () => () => {} }));
vi.mock('@server/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));

const mockTryIncrement = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ cacheRepository: { tryIncrementWithinLimitFixedWindow: mockTryIncrement } }));
const mockAuditCreate = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/auth', () => ({ UserApiKeyAuditLog: { create: mockAuditCreate } }));

const mockVerifyEmbedApiKey = vi.hoisted(() => vi.fn());
vi.mock('@server/cli/auth', () => ({ verifyEmbedApiKey: mockVerifyEmbedApiKey }));

const mockResolveIdentifiedEmbedUser = vi.hoisted(() => vi.fn());
vi.mock('@server/embed/identifiedEmbedUser', async () => {
  const actual = await vi.importActual<typeof import('@server/embed/identifiedEmbedUser')>(
    '@server/embed/identifiedEmbedUser'
  );
  return {
    IdentifiedEmbedMintSchema: actual.IdentifiedEmbedMintSchema,
    resolveIdentifiedEmbedUser: mockResolveIdentifiedEmbedUser,
  };
});

import handler from '../session';
import { verifyEmbedSessionToken } from '@server/embed/embedSessionToken';

const KEY_INFO = {
  keyId: 'key-1',
  userId: 'owner-1',
  agentId: 'agent-1',
  organizationId: 'org-1',
  allowedOrigins: ['https://host.example.com'],
  identifiedClientIds: ['client-1'],
};
const IDENTIFIED_BODY = { client_id: 'client-1', client_secret: 'secret', id_token: 'id-token' };

async function mint(body: unknown, headers: Record<string, string> = {}) {
  const { req, res } = createMocks({
    method: 'POST',
    body: body as Record<string, unknown>,
    headers: { 'x-api-key': 'b4m_live_embed', host: 'app.example.com', ...headers },
  });
  (req as unknown as { logger: object }).logger = { info: vi.fn(), warn: vi.fn() };
  await (handler as unknown as (q: typeof req, s: typeof res) => Promise<void>)(req, res);
  return { status: res._getStatusCode(), json: res._getJSONData() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyEmbedApiKey.mockResolvedValue(KEY_INFO);
  mockResolveIdentifiedEmbedUser.mockResolvedValue({ userId: 'host-user-1' });
  mockTryIncrement.mockResolvedValue({ success: true, expiresAt: new Date(Date.now() + 60_000) });
});

describe('POST /api/embed/session', () => {
  it('mints an anonymous token with no end user when no identity is presented', async () => {
    const { status, json } = await mint({});
    expect(status).toBe(200);
    expect(json.mode).toBe('anonymous');
    expect(verifyEmbedSessionToken(json.session_token).endUserId).toBeUndefined();
    expect(mockResolveIdentifiedEmbedUser).not.toHaveBeenCalled();
  });

  it("binds an identified token to the host's authenticated user", async () => {
    const { status, json } = await mint(IDENTIFIED_BODY);
    expect(status).toBe(200);
    expect(json.mode).toBe('identified');
    const claims = verifyEmbedSessionToken(json.session_token);
    expect(claims).toMatchObject({
      keyId: 'key-1',
      agentId: 'agent-1',
      organizationId: 'org-1',
      endUserId: 'host-user-1',
      oauthClientId: 'client-1',
    });
    expect(mockResolveIdentifiedEmbedUser).toHaveBeenCalledWith(IDENTIFIED_BODY, ['client-1'], expect.anything());
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mint', keyId: 'key-1', actorUserId: 'host-user-1' })
    );
  });

  it('refuses an identified mint from a browser, since it carries a client secret', async () => {
    const { status, json } = await mint(IDENTIFIED_BODY, { origin: 'https://host.example.com' });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_request');
    expect(mockResolveIdentifiedEmbedUser).not.toHaveBeenCalled();
  });

  it('rejects a partial identified body rather than falling back to an anonymous session', async () => {
    const { status } = await mint({ id_token: 'id-token' });
    expect(status).toBe(400);
    expect(mockResolveIdentifiedEmbedUser).not.toHaveBeenCalled();
  });

  it('applies a per-client identified mint budget', async () => {
    mockTryIncrement.mockResolvedValue({ success: false, expiresAt: new Date(Date.now() + 30_000) });
    const { status } = await mint(IDENTIFIED_BODY);
    expect(status).toBe(429);
    expect(mockTryIncrement.mock.calls[0][0]).toContain('client-1');
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('rejects an identified token that lacks its client binding', () => {
    const unbound = jwt.sign(
      { keyId: 'key-1', agentId: 'a', organizationId: 'o', sessionId: 's', endUserId: 'u' },
      'test-secret',
      { audience: 'embed-chat' }
    );
    expect(() => verifyEmbedSessionToken(unbound)).toThrow(/client binding/);
  });

  it('passes through a handoff rejection without minting', async () => {
    mockResolveIdentifiedEmbedUser.mockResolvedValue({
      rejection: { status: 401, error: 'invalid_grant', error_description: 'Invalid ID token' },
    });
    const { status, json } = await mint(IDENTIFIED_BODY);
    expect(status).toBe(401);
    expect(json).toEqual({ error: 'invalid_grant', error_description: 'Invalid ID token' });
  });

  it('a token forged without the server secret does not verify', () => {
    const forged = jwt.sign(
      { keyId: 'key-1', agentId: 'a', organizationId: 'o', sessionId: 's', endUserId: 'victim' },
      'wrong',
      {
        audience: 'embed-chat',
      }
    );
    expect(() => verifyEmbedSessionToken(forged)).toThrow();
  });
});
