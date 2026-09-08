import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The PUT handler is the authoritative write boundary for a lake's preferred prompt: it is the one
 * place that owns the session-activatable allowlist, so a non-activatable id must be rejected here
 * (fail loud) rather than stored for the session resolver to silently drop later. These pin that
 * the allowlist check is WIRED into the handler and runs BEFORE the update reaches the service.
 */
const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeWritable: vi.fn(),
  updateDataLake: vi.fn(),
  toAccessContext: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.PUT = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  // The config-audit repos this route wires (see lakeConfigAuditDb). Stubbed rather than
  // omitted because the mock replaces the whole module: a missing export is an import-time
  // failure, not a silent undefined.
  lakeConfigChangeEventRepository: { record: vi.fn().mockResolvedValue({}) },
  dataLakeBatchRepository: {},
  fabFileRepository: {},
  dataLakeAccessGrantRepository: {
    listByLake: vi.fn().mockResolvedValue([]),
    listActiveByLakes: vi.fn().mockResolvedValue([]),
    listByPrincipal: vi.fn().mockResolvedValue([]),
    findGrant: vi.fn().mockResolvedValue(null),
    upsertGrant: vi.fn().mockResolvedValue({}),
    removeGrant: vi.fn().mockResolvedValue(true),
    removeAllForLake: vi.fn().mockResolvedValue(0),
  },
  // ONE declaration, deliberately: this key was previously declared twice and the second silently
  // shadowed the first, dropping the retention methods the audit path reads. It serves two
  // consumers - the GET route's #1673 cutover flag (getSettingsValue) and the config-audit
  // retention resolver (findBySettingNames/findAll) - so both live here.
  adminSettingsRepository: {
    getSettingsValue: vi.fn().mockResolvedValue(false),
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
// Real allowlist predicate on purpose - the whole point is which ids pass.
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    assertLakeWritable: h.assertLakeWritable,
    updateDataLake: h.updateDataLake,
  },
}));

import handler from '../[id]';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const put = (body: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ method: 'PUT', query: { id: 'lake1' }, body, ...over }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

describe('PUT /api/data-lakes/[id] - preferredSystemPromptId allowlist is enforced at the write boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'owner', isAdmin: false, userTags: [] });
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', createdByUserId: 'owner' });
    h.updateDataLake.mockResolvedValue({ id: 'lake1', preferredSystemPromptId: 'triage_router' });
  });

  it('rejects a non-activatable prompt id BEFORE touching the service', async () => {
    const { res } = makeRes();
    await expect(run(put({ name: 'L', preferredSystemPromptId: 'totally_made_up' }), res)).rejects.toThrow(
      /not a valid preferred system prompt/i
    );
    // Fail loud and early: neither the access gate nor the update ran.
    expect(h.assertLakeAccess).not.toHaveBeenCalled();
    expect(h.updateDataLake).not.toHaveBeenCalled();
  });

  it('accepts an activatable id and forwards it to the update service', async () => {
    const { res, json } = makeRes();
    await run(put({ name: 'L', preferredSystemPromptId: 'triage_router' }), res);
    expect(h.updateDataLake).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner', isAdmin: false }),
      'lake1',
      expect.objectContaining({ preferredSystemPromptId: 'triage_router' }),
      // Not expect.anything(): the config-audit repos are wired through one shared helper and a
      // route that dropped `adminSettings` would still compile (it is optional so the retention
      // read stays best-effort) and would silently pin every event to the floor default.
      expect.objectContaining({
        db: expect.objectContaining({
          lakeConfigChangeEvents: expect.anything(),
          adminSettings: expect.anything(),
        }),
      })
    );
    expect(json.mock.calls[0][0].preferredSystemPromptId).toBe('triage_router');
  });

  /**
   * API-key attribution, asserted at the ROUTE because that is the only place it exists: the actor is
   * built here and `lakeConfigAuditPrincipal` is not mocked, so this exercises the real helper.
   *
   * Silent failure mode: delete the `auditPrincipal` line from this route and every other suite stays
   * green while key-driven writes are recorded as the owning human's own edit, permanently, in
   * append-only rows.
   */
  it('attaches the KEY as the audit principal when the caller authenticated with an API key', async () => {
    const { res } = makeRes();
    await run(put({ name: 'L' }, { user: { id: 'owner' }, apiKeyInfo: { keyId: 'key-abc' } }), res);
    expect(h.updateDataLake).toHaveBeenCalledWith(
      expect.objectContaining({
        auditPrincipal: { principalKind: 'apiKey', principalId: 'key-abc', onBehalfOfUserId: 'owner' },
      }),
      'lake1',
      expect.anything(),
      expect.anything()
    );
  });

  it('attaches NO audit principal for a session write, leaving the service derivation alone', async () => {
    const { res } = makeRes();
    await run(put({ name: 'L' }, { user: { id: 'owner' }, apiKeyInfo: undefined }), res);
    const actor = h.updateDataLake.mock.calls[0][0] as { auditPrincipal?: unknown };
    expect(actor.auditPrincipal).toBeUndefined();
  });

  it('accepts the empty-string clear sentinel (removing the binding)', async () => {
    const { res } = makeRes();
    await run(put({ name: 'L', preferredSystemPromptId: '' }), res);
    expect(h.updateDataLake).toHaveBeenCalledWith(
      expect.anything(),
      'lake1',
      expect.objectContaining({ preferredSystemPromptId: '' }),
      expect.anything()
    );
  });
});
