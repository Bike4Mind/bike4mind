import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The route stamps the session's origin from how the request authenticated, passed to createSession
 * as an option. A body-supplied `origin` must never become the stamp.
 */
const h = vi.hoisted(() => ({
  createSession: vi.fn(),
  findByIdAndUpdate: vi.fn(),
  logEvent: vi.fn(),
}));

// Runs the contract's real request parse, as nextRouteForContract does, ahead of the handler.
vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: (contract: { request: { parse: (b: unknown) => unknown } }) => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      post: (fn: (req: { body: unknown; validated?: unknown }, res: unknown) => unknown) => (
        (routes.POST = (req, res) => {
          const r = req as { body: unknown; validated?: unknown };
          r.validated = contract.request.parse(r.body);
          return fn(r, res);
        }),
        chain
      ),
    });
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  organizationRepository: { findIdsWithAdminRights: vi.fn().mockResolvedValue([]) },
  projectRepository: {},
  agentRepository: {},
  sessionRepository: {},
  fabFileRepository: {},
  fallbackLakeSettingsRepository: {},
  userRepository: {},
  activityRepository: {},
  User: { findByIdAndUpdate: h.findByIdAndUpdate },
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: h.logEvent }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: vi.fn() }));
vi.mock('@client/config/activities', () => ({ ActivityType: { NOTEBOOK_ADDED_TO_PROJECT: 'added' } }));
vi.mock('@bike4mind/services', () => ({
  sessionService: { createSession: h.createSession, resolveLakeSessionDefaults: vi.fn() },
  dataLakeService: { assertLakeAccess: vi.fn(), resolveCanManageLake: vi.fn() },
  projectService: { get: vi.fn() },
}));

import handler from '../index';

const makeRes = () => {
  const json = vi.fn();
  return { json, status: vi.fn(() => ({ json })) } as never;
};
const post = (body: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ method: 'POST', user: { id: 'u1' }, ability: {}, headers: {}, body, ...extra }) as never;
const run = (req: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, makeRes());
const optionsOf = () => h.createSession.mock.calls[0][3] as { origin?: unknown } | undefined;

describe('POST /api/v1/sessions - origin stamping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createSession.mockResolvedValue({ id: 's1', name: 'New Notebook', knowledgeIds: [], agentIds: [] });
    h.findByIdAndUpdate.mockResolvedValue(undefined);
  });

  it('stamps api with the key id for an API-key request', async () => {
    await run(post({ name: 'N' }, { apiKeyInfo: { keyId: 'key-1', scopes: [] } }));
    expect(optionsOf()?.origin).toEqual({ channel: 'api', apiKeyId: 'key-1' });
  });

  it('stamps web for a JWT request', async () => {
    await run(post({ name: 'N' }));
    expect(optionsOf()?.origin).toEqual({ channel: 'web' });
  });

  it('stamps cli for a JWT request from the CLI', async () => {
    await run(post({ name: 'N' }, { headers: { 'x-b4m-client': 'b4m-cli/2.0.0' } }));
    expect(optionsOf()?.origin).toEqual({ channel: 'cli' });
  });

  it('never takes the origin from the body', async () => {
    await run(post({ name: 'N', origin: { channel: 'slack' } }, { apiKeyInfo: { keyId: 'key-1', scopes: [] } }));
    expect(optionsOf()?.origin).toEqual({ channel: 'api', apiKeyId: 'key-1' });
  });
});
