import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyScope, ForbiddenError } from '@bike4mind/common';

/**
 * The route gate admits ai:generate, so a key holding it without notebooks:write may create only a
 * bare session. Anything that can attach the session to shared content stays behind notebooks:write.
 */
const h = vi.hoisted(() => ({
  createSession: vi.fn(),
  findByIdAndUpdate: vi.fn(),
  projectGet: vi.fn(),
  assertLakeAccess: vi.fn(),
}));

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: (contract: { request: { parse: (b: unknown) => unknown } }) => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      get: () => chain,
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
vi.mock('@server/middlewares/baseApi', () => ({ methodNotAllowedHandler: () => () => undefined }));
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
  activityRepository: { createActivity: vi.fn() },
  User: { findByIdAndUpdate: h.findByIdAndUpdate },
}));
vi.mock('@server/entitlements', () => ({ getRequestEntitlements: vi.fn().mockResolvedValue(['base']) }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: vi.fn() }));
vi.mock('@bike4mind/services', () => ({
  sessionService: { createSession: h.createSession, resolveLakeSessionDefaults: vi.fn().mockReturnValue({}) },
  dataLakeService: { assertLakeAccess: h.assertLakeAccess, resolveCanManageLake: vi.fn() },
  projectService: { get: h.projectGet },
}));

import handler from '../index';

const makeRes = () => {
  const json = vi.fn();
  return { json, status: vi.fn(() => ({ json })) } as never;
};
const post = (body: Record<string, unknown>, apiKeyInfo?: { scopes: ApiKeyScope[] }) =>
  ({ method: 'POST', user: { id: 'u1', tags: [] }, ability: {}, body, apiKeyInfo }) as never;
const run = (req: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, makeRes());

const generateOnly = { scopes: [ApiKeyScope.AI_GENERATE] };

describe('POST /api/v1/sessions - ai:generate-only key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createSession.mockResolvedValue({ id: 's1', name: 'N', knowledgeIds: [], agentIds: [] });
    h.findByIdAndUpdate.mockResolvedValue(undefined);
    h.projectGet.mockResolvedValue({ name: 'P' });
    h.assertLakeAccess.mockResolvedValue({});
  });

  it('creates a bare session', async () => {
    await run(post({ name: 'N' }, generateOnly));
    expect(h.createSession).toHaveBeenCalledTimes(1);
  });

  it('allows the bare-session fields and ignores null values', async () => {
    await run(post({ name: 'N', temperature: 0.2, lastUsedModel: 'm', dataLakeId: null }, generateOnly));
    expect(h.createSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['projectId', { projectId: 'p1' }],
    ['dataLakeId', { dataLakeId: 'l1' }],
    ['retrievalTags', { retrievalTags: ['t'] }],
    ['surface', { surface: 'some-private-surface' }],
    ['preauthorizedLakeIds', { preauthorizedLakeIds: ['l1'] }],
    ['knowledgeIds', { knowledgeIds: ['f1'] }],
    ['agentIds', { agentIds: ['a1'] }],
    ['includeLibraryFiles', { includeLibraryFiles: true }],
  ])('403s naming notebooks:write when %s is set', async (_name, extra) => {
    const err = await run(post({ name: 'N', ...extra }, generateOnly)).catch(e => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).toMatchObject({
      statusCode: 403,
      additionalInfo: { required_scopes: [ApiKeyScope.WRITE_NOTEBOOKS] },
    });
    expect(h.createSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/sessions - callers that keep today behaviour', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createSession.mockResolvedValue({ id: 's1', name: 'N', knowledgeIds: [], agentIds: [] });
    h.findByIdAndUpdate.mockResolvedValue(undefined);
    h.projectGet.mockResolvedValue({ name: 'P' });
  });

  it('lets a notebooks:write key attach a project', async () => {
    await run(post({ name: 'N', projectId: 'p1' }, { scopes: [ApiKeyScope.WRITE_NOTEBOOKS, ApiKeyScope.AI_GENERATE] }));
    expect(h.createSession).toHaveBeenCalledTimes(1);
  });

  it('lets a JWT caller (no apiKeyInfo) attach a project', async () => {
    await run(post({ name: 'N', projectId: 'p1' }));
    expect(h.createSession).toHaveBeenCalledTimes(1);
  });
});
