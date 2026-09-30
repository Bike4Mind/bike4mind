import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Mock baseApi so `.get(fn)` returns the handler fn directly (invoke it ourselves).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ get: (fn: any) => fn }),
}));

vi.mock('@server/utils/config', () => ({ Config: { JWT_SECRET: 'test-jwt-secret' } }));

vi.mock('@bike4mind/database', () => ({
  mcpServerRepository: { findOne: vi.fn(), update: vi.fn(), create: vi.fn() },
  userRepository: { findById: vi.fn() },
  adminSettingsRepository: {},
}));

vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: (key: string) => (key === 'githubMcpClientId' ? 'client-id' : 'client-secret'),
}));

vi.mock('@server/auth/oauthFlowCookie', () => ({
  readStateNonceHash: () => 'nonce-hash',
  clearStateNonce: vi.fn(),
}));

vi.mock('@server/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: { create: () => ({ setUserId: vi.fn(), success: vi.fn(), failure: vi.fn() }) },
}));

vi.mock('@server/security/tokenEncryption', () => ({
  encryptEnvVariables: () => [{ key: 'GITHUB_ACCESS_TOKEN', value: 'encrypted' }],
}));

// Tool discovery is best-effort; make it fail fast so only the connect write is exercised.
vi.mock('@server/utils/invokeMcpHandler', () => ({
  invokeMcpHandler: vi.fn().mockRejectedValue(new Error('discovery skipped in test')),
}));

import jwt from 'jsonwebtoken';
import handler from '@pages/api/auth/github/mcp-callback';
import { mcpServerRepository, userRepository } from '@bike4mind/database';

const mockFindOne = vi.mocked(mcpServerRepository.findOne);
const mockUpdate = vi.mocked(mcpServerRepository.update);

const WEBHOOK = {
  routingToken: 'routing-token-1',
  secret: 'encrypted-secret',
  subscribedEvents: ['pull_request'],
  repos: ['octo/repo'],
  createdAt: '2026-01-01T00:00:00.000Z',
};
const SELECTED = [{ fullName: 'octo/repo', owner: 'octo', repo: 'repo' }];

function existingServer(metadata: unknown) {
  return {
    id: 'server-1',
    userId: 'user-123',
    enabled: true,
    // Outside the 30s idempotency window.
    metadata,
  } as any;
}

function makeReqRes() {
  const state = jwt.sign({ userId: 'user-123', nh: 'nonce-hash' }, 'test-jwt-secret', { algorithm: 'HS256' });
  const { req, res } = createMocks({ method: 'GET', query: { code: 'oauth-code', state } });
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

function stubGitHub(login: string | undefined) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('access_token')
        ? { json: async () => ({ access_token: 'gho_token', scope: 'repo,read:user' }) }
        : { json: async () => ({ login }) }
    )
  );
}

describe('/api/auth/github/mcp-callback reconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userRepository.findById).mockResolvedValue({ id: 'user-123' } as any);
    mockUpdate.mockImplementation(async data => data as any);
  });

  it('same account: writes only metadata leaves so webhooks and selected repos survive', async () => {
    mockFindOne.mockResolvedValue(
      existingServer({
        githubLogin: 'octocat',
        connectedAt: '2026-01-01T00:00:00.000Z',
        scope: 'repo',
        selectedRepositories: SELECTED,
        webhooks: { github: WEBHOOK },
      })
    );
    stubGitHub('octocat');

    const { req, res } = makeReqRes();
    await handler(req, res);

    expect(res._getRedirectUrl()).toContain('github_oauth=success');
    const [data, options] = mockUpdate.mock.calls[0];
    expect(data).toEqual({
      id: 'server-1',
      enabled: true,
      envVariables: [{ key: 'GITHUB_ACCESS_TOKEN', value: 'encrypted' }],
      tools: [],
      'metadata.githubLogin': 'octocat',
      'metadata.connectedAt': expect.any(String),
      'metadata.scope': 'repo,read:user',
    });
    expect(data).not.toHaveProperty('metadata');
    expect(options).toEqual({ unset: ['metadata.disconnectedAt'] });
  });

  it('different account: replaces metadata wholesale, dropping the old webhook and selection', async () => {
    mockFindOne.mockResolvedValue(
      existingServer({
        githubLogin: 'octocat',
        connectedAt: '2026-01-01T00:00:00.000Z',
        selectedRepositories: SELECTED,
        webhooks: { github: WEBHOOK },
      })
    );
    stubGitHub('someone-else');

    const { req, res } = makeReqRes();
    await handler(req, res);

    expect(res._getRedirectUrl()).toContain('github_oauth=success');
    const [data, options] = mockUpdate.mock.calls[0];
    expect(data).toEqual({
      id: 'server-1',
      enabled: true,
      envVariables: [{ key: 'GITHUB_ACCESS_TOKEN', value: 'encrypted' }],
      tools: [],
      metadata: { githubLogin: 'someone-else', connectedAt: expect.any(String), scope: 'repo,read:user' },
    });
    expect(options).toBeUndefined();
  });

  it('stored metadata: null falls back to a full replace (a dotted $set into null would throw)', async () => {
    mockFindOne.mockResolvedValue(existingServer(null));
    stubGitHub('octocat');

    const { req, res } = makeReqRes();
    await handler(req, res);

    expect(res._getRedirectUrl()).toContain('github_oauth=success');
    const [data] = mockUpdate.mock.calls[0];
    expect(data).toMatchObject({ metadata: { githubLogin: 'octocat' } });
  });

  it('missing GitHub login never counts as the same account, even when none was stored', async () => {
    mockFindOne.mockResolvedValue(existingServer({ scope: 'repo', webhooks: { github: WEBHOOK } }));
    stubGitHub(undefined);

    const { req, res } = makeReqRes();
    await handler(req, res);

    const [data, options] = mockUpdate.mock.calls[0];
    expect(data).toHaveProperty('metadata');
    expect(data).not.toHaveProperty(['metadata.githubLogin']);
    expect(options).toBeUndefined();
  });
});
