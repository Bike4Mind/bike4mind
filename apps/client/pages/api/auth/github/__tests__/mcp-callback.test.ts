import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { getSettingsMap } from '@bike4mind/utils';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';

const mockFindOne = vi.mocked(mcpServerRepository.findOne);
const mockUpdate = vi.mocked(mcpServerRepository.update);
const mockCreate = vi.mocked(mcpServerRepository.create);

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
    // Outside the 30s idempotency window (fixtures use a stale connectedAt).
    metadata,
  } as any;
}

function makeReqRes() {
  const state = jwt.sign({ userId: 'user-123', nh: 'nonce-hash' }, 'test-jwt-secret', { algorithm: 'HS256' });
  const { req, res } = createMocks({ method: 'GET', query: { code: 'oauth-code', state } });
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

const OCTOCAT = { login: 'octocat', id: 583231 };

// `user` is the /user JSON body, verbatim.
function stubGitHub(user: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('access_token')
        ? { ok: true, json: async () => ({ access_token: 'gho_token', scope: 'repo,read:user' }) }
        : { ok, status: ok ? 200 : 403, json: async () => user }
    )
  );
}

const CONNECTION_FIELDS = {
  id: 'server-1',
  enabled: true,
  envVariables: [{ key: 'GITHUB_ACCESS_TOKEN', value: 'encrypted' }],
  tools: [],
};

async function run() {
  const { req, res } = makeReqRes();
  await handler(req, res);
  return res;
}

function expectLeafUpdate(login: string, id: number) {
  const [data, options] = mockUpdate.mock.calls[0];
  expect(data).toEqual({
    ...CONNECTION_FIELDS,
    'metadata.githubLogin': login,
    'metadata.githubUserId': id,
    'metadata.connectedAt': expect.any(String),
    'metadata.scope': 'repo,read:user',
  });
  expect(options).toBeUndefined();
}

function expectFullReplace(login: string, id: number) {
  const [data, options] = mockUpdate.mock.calls[0];
  expect(data).toEqual({
    ...CONNECTION_FIELDS,
    metadata: { githubLogin: login, githubUserId: id, connectedAt: expect.any(String), scope: 'repo,read:user' },
  });
  expect(options).toBeUndefined();
}

const STALE = '2026-01-01T00:00:00.000Z';

describe('/api/auth/github/mcp-callback reconnect', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // resetAllMocks also wipes the vi.mock factory implementations; re-seed them.
    vi.mocked(getSettingsMap).mockResolvedValue({} as any);
    vi.mocked(invokeMcpHandler).mockRejectedValue(new Error('discovery skipped in test'));
    vi.mocked(userRepository.findById).mockResolvedValue({ id: 'user-123' } as any);
    mockUpdate.mockImplementation(async data => data as any);
    mockCreate.mockImplementation(async data => ({ ...data, id: 'server-new' }) as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('same account id: writes only metadata leaves so webhooks and selected repos survive', async () => {
    mockFindOne.mockResolvedValue(
      existingServer({
        ...OCTOCAT,
        githubUserId: OCTOCAT.id,
        connectedAt: STALE,
        scope: 'repo',
        selectedRepositories: SELECTED,
        webhooks: { github: WEBHOOK },
      })
    );
    stubGitHub(OCTOCAT);

    const res = await run();

    expect(res._getRedirectUrl()).toContain('github_oauth=success');
    expectLeafUpdate('octocat', OCTOCAT.id);
  });

  it('no stored identity (repo selection saved before the first connect): preserves via leaf update', async () => {
    mockFindOne.mockResolvedValue(existingServer({ selectedRepositories: SELECTED }));
    stubGitHub(OCTOCAT);

    const res = await run();

    expect(res._getRedirectUrl()).toContain('github_oauth=success');
    expectLeafUpdate('octocat', OCTOCAT.id);
  });

  it.each([
    ['a renamed login', 'octocat-renamed'],
    ['a case-only login change', 'OctoCat'],
  ])('same id with %s: leaf update', async (_label, newLogin) => {
    mockFindOne.mockResolvedValue(
      existingServer({
        githubLogin: 'octocat',
        githubUserId: OCTOCAT.id,
        connectedAt: STALE,
        webhooks: { github: WEBHOOK },
      })
    );
    stubGitHub({ login: newLogin, id: OCTOCAT.id });

    await run();

    expectLeafUpdate(newLogin, OCTOCAT.id);
  });

  it('legacy doc with only a login, same login in another case: leaf update', async () => {
    mockFindOne.mockResolvedValue(
      existingServer({ githubLogin: 'OctoCat', connectedAt: STALE, webhooks: { github: WEBHOOK } })
    );
    stubGitHub(OCTOCAT);

    await run();

    expectLeafUpdate('octocat', OCTOCAT.id);
  });

  it('different account id (even with the same login): replaces metadata wholesale', async () => {
    mockFindOne.mockResolvedValue(
      existingServer({
        ...OCTOCAT,
        githubUserId: OCTOCAT.id,
        connectedAt: STALE,
        selectedRepositories: SELECTED,
        webhooks: { github: WEBHOOK },
      })
    );
    stubGitHub({ login: 'octocat', id: 999 });

    const res = await run();

    expect(res._getRedirectUrl()).toContain('github_oauth=success');
    expectFullReplace('octocat', 999);
  });

  it('legacy doc with a different login: replaces metadata wholesale', async () => {
    mockFindOne.mockResolvedValue(
      existingServer({ githubLogin: 'octocat', connectedAt: STALE, webhooks: { github: WEBHOOK } })
    );
    stubGitHub({ login: 'someone-else', id: 42 });

    await run();

    expectFullReplace('someone-else', 42);
  });

  it('stored metadata: null falls back to a full replace (a dotted $set into null would throw)', async () => {
    mockFindOne.mockResolvedValue(existingServer(null));
    stubGitHub(OCTOCAT);

    const res = await run();

    expect(res._getRedirectUrl()).toContain('github_oauth=success');
    expectFullReplace('octocat', OCTOCAT.id);
  });

  it('first connect stores the id on create', async () => {
    mockFindOne.mockResolvedValue(null);
    stubGitHub(OCTOCAT);

    await run();

    expect(mockCreate.mock.calls[0][0].metadata).toEqual({
      githubLogin: 'octocat',
      githubUserId: OCTOCAT.id,
      connectedAt: expect.any(String),
      scope: 'repo,read:user',
    });
  });

  it.each([
    ['a non-2xx /user response', { message: 'API rate limit exceeded' }, false],
    ['a /user body without a login', { id: OCTOCAT.id }, true],
    ['a /user body without an id', { login: 'octocat' }, true],
    ['a 200 with a null body', null, true],
  ])('%s aborts before any write, keeping the stored webhook', async (_label, user, ok) => {
    mockFindOne.mockResolvedValue(
      existingServer({ githubLogin: 'octocat', connectedAt: STALE, webhooks: { github: WEBHOOK } })
    );
    stubGitHub(user, ok);

    const res = await run();

    expect(res._getRedirectUrl()).toContain('github_oauth=error&error=github_user_lookup_failed');
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['a failed /user lookup', { message: 'Bad credentials' }, false],
    ['a /user body without a login', { id: OCTOCAT.id }, true],
  ])('%s on first connect creates nothing', async (_label, user, ok) => {
    mockFindOne.mockResolvedValue(null);
    stubGitHub(user, ok);

    const res = await run();

    expect(res._getRedirectUrl()).toContain('error=github_user_lookup_failed');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a callback within the 30s idempotency window redirects to success without writing', async () => {
    mockFindOne.mockResolvedValue(
      existingServer({ githubLogin: 'octocat', connectedAt: new Date().toISOString(), webhooks: { github: WEBHOOK } })
    );
    stubGitHub(OCTOCAT);

    const res = await run();

    expect(res._getRedirectUrl()).toContain('github_oauth=success');
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a callback exactly 30s after the last connect is outside the window and reconnects', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T00:00:30.000Z'));
    mockFindOne.mockResolvedValue(
      existingServer({ ...OCTOCAT, githubUserId: OCTOCAT.id, connectedAt: '2026-09-30T00:00:00.000Z' })
    );
    stubGitHub(OCTOCAT);

    await run();

    expect(global.fetch).toHaveBeenCalled();
    expectLeafUpdate('octocat', OCTOCAT.id);
  });
});
