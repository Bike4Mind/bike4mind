import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError, OPTI_SURFACE } from '@bike4mind/common';

/**
 * A registered product surface is entitlement-gated at create time, the same rule clone/fork/move
 * apply (canUseSurface). An unregistered surface string passes through untouched: private modules
 * create their sessions that way and this repo does not know their names.
 */
const h = vi.hoisted(() => ({
  createSession: vi.fn(),
  findByIdAndUpdate: vi.fn(),
  getRequestEntitlements: vi.fn(),
}));

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: (contract: { request: { parse: (b: unknown) => unknown } }) => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      // The same page also serves GET (listSessions); these tests only exercise POST.
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
// dispatchByMethod (the page also serves GET) pulls the real baseApi, which needs a live DB module.
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
  activityRepository: {},
  User: { findByIdAndUpdate: h.findByIdAndUpdate },
}));
vi.mock('@server/entitlements', () => ({ getRequestEntitlements: h.getRequestEntitlements }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
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
const post = (body: Record<string, unknown>, user: Record<string, unknown> = { id: 'u1', tags: [] }) =>
  ({ method: 'POST', user, ability: {}, body }) as never;
const run = (req: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, makeRes());

describe('POST /api/v1/sessions - surface entitlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createSession.mockResolvedValue({ id: 's1', name: 'N', knowledgeIds: [], agentIds: [] });
    h.findByIdAndUpdate.mockResolvedValue(undefined);
    h.getRequestEntitlements.mockResolvedValue(['base']);
  });

  it('403s an opti session for a caller without the entitlement', async () => {
    await expect(run(post({ name: 'N', surface: OPTI_SURFACE }))).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it('creates an opti session for an entitled caller', async () => {
    h.getRequestEntitlements.mockResolvedValue(['base', 'optihashi:pro']);

    await run(post({ name: 'N', surface: OPTI_SURFACE }));

    expect(h.createSession.mock.calls[0][1]).toMatchObject({ surface: OPTI_SURFACE });
  });

  it('lets an admin create an opti session without the entitlement', async () => {
    await run(post({ name: 'N', surface: OPTI_SURFACE }, { id: 'u1', isAdmin: true }));

    expect(h.createSession).toHaveBeenCalled();
  });

  it('passes an unregistered surface through without an entitlement read', async () => {
    await run(post({ name: 'N', surface: 'some-private-surface' }));

    expect(h.getRequestEntitlements).not.toHaveBeenCalled();
    expect(h.createSession.mock.calls[0][1]).toMatchObject({ surface: 'some-private-surface' });
  });

  it('does not read entitlements for an ordinary main-list create', async () => {
    await run(post({ name: 'N' }));

    expect(h.getRequestEntitlements).not.toHaveBeenCalled();
    expect(h.createSession).toHaveBeenCalled();
  });
});
