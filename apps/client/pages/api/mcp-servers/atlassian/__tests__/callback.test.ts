// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import crypto from 'crypto';

const { JWT_SECRET, mockFindById, mockReadStateNonceHash, mockClearStateNonce, mockAuditSuccess, mockAuditFailure } =
  vi.hoisted(() => ({
    JWT_SECRET: 'test-secret',
    mockFindById: vi.fn(),
    mockReadStateNonceHash: vi.fn(),
    mockClearStateNonce: vi.fn(),
    mockAuditSuccess: vi.fn(),
    mockAuditFailure: vi.fn(),
  }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (fn: (req: unknown, res: unknown) => unknown) => ((h.GET = fn), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({ userRepository: { findById: (...a: unknown[]) => mockFindById(...a) } }));
vi.mock('@server/integrations/jira/atlassianConfig', () => ({
  getAtlassianOAuthConfig: vi.fn(async () => ({ clientId: 'c', clientSecret: 's', redirectUri: 'r' })),
}));
vi.mock('@server/utils/config', () => ({ Config: { JWT_SECRET } }));
vi.mock('@server/auth/oauthFlowCookie', () => ({
  readStateNonceHash: (...a: unknown[]) => mockReadStateNonceHash(...a),
  clearStateNonce: (...a: unknown[]) => mockClearStateNonce(...a),
}));
vi.mock('@server/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: {
    create: () => ({
      setUserId: vi.fn(),
      success: (...a: unknown[]) => mockAuditSuccess(...a),
      failure: (...a: unknown[]) => mockAuditFailure(...a),
    }),
  },
}));
vi.mock('@server/security/tokenEncryption', () => ({ encryptToken: (t: string) => t }));

import handler from '../callback';

const USER_ID = 'user-1';
const NONCE_HASH = 'nonce-hash';

/** The state this handler's own connect step emits: signed over the same four fields. */
const signedState = () => {
  const csrfToken = 'csrf';
  const timestamp = Date.now();
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${USER_ID}:${csrfToken}:${timestamp}:${NONCE_HASH}`)
    .digest('hex');
  return JSON.stringify({ userId: USER_ID, csrfToken, timestamp, nonceHash: NONCE_HASH, signature });
};

const run = async () => {
  const { req, res } = createMocks({ method: 'GET', query: { code: 'auth-code', state: signedState() } });
  await (handler as unknown as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/mcp-servers/atlassian/callback - duplicate delivery', () => {
  it('reports the existing connection when the nonce cookie is already burned', async () => {
    // The first callback clears the cookie, so a refresh or Back through this handler arrives with
    // none. Gating that on the nonce would show an error banner - and write a session_mismatch
    // audit row - for a link that is live.
    mockReadStateNonceHash.mockReturnValue(null);
    mockFindById.mockResolvedValue({ atlassianConnect: { status: 'connected' } });

    const res = await run();

    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&atlassian=connected');
    expect(mockAuditSuccess).toHaveBeenCalledWith({ isDuplicate: true });
    expect(mockAuditFailure).not.toHaveBeenCalled();
  });

  it('still fails closed on a missing nonce when there is no connection to restate', async () => {
    // The binding itself is unchanged: only an already-connected user skips it, and that branch
    // exchanges nothing and grants nothing.
    mockReadStateNonceHash.mockReturnValue(null);
    mockFindById.mockResolvedValue({ atlassianConnect: { status: 'pending' } });

    const res = await run();

    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&atlassian=error');
    expect(mockAuditFailure).toHaveBeenCalledWith('session_mismatch');
  });
});
