import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Unwrap the handler: baseApi().use(...).use(...).post(fn) => fn
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = { use: () => chain, post: (fn: any) => fn };
    return chain;
  },
}));

// CORS + rate-limit middlewares are exercised in their own tests; no-op here.
vi.mock('@server/middlewares/embedCors', () => ({ embedCors: () => () => {} }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => {} }));

const mockVerifyEmbedApiKey = vi.fn();
vi.mock('@server/cli/auth', () => ({
  verifyEmbedApiKey: (...a: unknown[]) => mockVerifyEmbedApiKey(...a),
}));

// Real token verifier + origin gate - exercise the actual invariants, not stubs.
import handler from '../../../pages/api/embed/session';
import { verifyEmbedSessionToken } from '@server/embed/embedSessionToken';

const VALID_INFO = {
  keyId: 'key-1',
  userId: 'user-1',
  scopes: ['embed:chat'],
  rateLimit: { requestsPerMinute: 10, requestsPerDay: 100 },
  billingOwnerType: 'Organization',
  organizationId: 'org-1',
  agentId: 'agent-1',
  allowedOrigins: ['https://example.com'],
};

function makeReq(headers: Record<string, string> = {}) {
  const { req, res } = createMocks({ method: 'POST', headers });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).logger = { info: vi.fn(), warn: vi.fn() };
  return { req, res };
}

describe('POST /api/embed/session - mint embed session token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyEmbedApiKey.mockResolvedValue(VALID_INFO);
  });

  it('mints a token whose verified claims bind the key, agent, and org', async () => {
    const { req, res } = makeReq({ 'x-api-key': 'b4m_live_embed' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (handler as any)(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.token_type).toBe('Bearer');
    expect(body.agentId).toBe('agent-1');

    const claims = verifyEmbedSessionToken(body.session_token);
    expect(claims).toMatchObject({ keyId: 'key-1', agentId: 'agent-1', organizationId: 'org-1' });
    expect(claims.sessionId).toBeTruthy();
  });

  it('never returns the raw embed key', async () => {
    const { req, res } = makeReq({ 'x-api-key': 'b4m_live_embed' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (handler as any)(req, res);
    const raw = JSON.stringify(res._getJSONData());
    expect(raw).not.toContain('b4m_live_embed');
  });

  it('rejects an under-scoped / non-org key with 401', async () => {
    mockVerifyEmbedApiKey.mockRejectedValue(new Error('Embed keys must be organization-owned'));
    const { req, res } = makeReq({ 'x-api-key': 'b4m_live_bad' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (handler as any)(req, res);
    expect(res._getStatusCode()).toBe(401);
  });

  it('rejects a browser Origin not on the key allow-list with 403', async () => {
    const { req, res } = makeReq({ 'x-api-key': 'b4m_live_embed', origin: 'https://evil.com' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (handler as any)(req, res);
    expect(res._getStatusCode()).toBe(403);
  });

  it('accepts a request from an approved Origin', async () => {
    const { req, res } = makeReq({ 'x-api-key': 'b4m_live_embed', origin: 'https://example.com' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (handler as any)(req, res);
    expect(res._getStatusCode()).toBe(200);
  });
});
