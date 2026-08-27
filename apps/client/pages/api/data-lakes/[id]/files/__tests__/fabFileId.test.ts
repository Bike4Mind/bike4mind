import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Removing a file recomputes the lake's stats, which can flip a lake still in `draft` to `active`
 * and write an append-only config-change row a lake owner reads. The acting principal is resolved
 * HERE - `baseApi()` admits either a session or a `b4m_live_` key, and only the route can tell them
 * apart - so this is the only place the attribution can be pinned.
 *
 * Silent failure mode: drop the actor threading and every other suite stays green while a removal's
 * activation is recorded as `system`, or a key-driven one as the human it acted for.
 */
const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeWritable: vi.fn(),
  removeFileFromDataLake: vi.fn(),
  toAccessContext: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: { method?: string }, res: unknown) => routes[req.method ?? 'DELETE']?.(req, res),
      {
        use: () => chain,
        delete: (fn: (req: unknown, res: unknown) => unknown) => ((routes.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
// The whole module is replaced, so every repo the route (or lakeConfigAuditDb) names must be
// present - a missing export is an import-time failure, not a silent undefined.
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  fabFileRepository: {},
  lakeConfigChangeEventRepository: { record: vi.fn().mockResolvedValue({}) },
  adminSettingsRepository: {
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    assertLakeWritable: h.assertLakeWritable,
    removeFileFromDataLake: h.removeFileFromDataLake,
  },
}));

import handler from '../[fabFileId]';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};

const run = (over: Record<string, unknown> = {}) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(
    {
      method: 'DELETE',
      query: { id: 'lake1', fabFileId: 'f1' },
      user: { id: 'owner' },
      logger: { error: vi.fn(), warn: vi.fn() },
      ...over,
    } as never,
    makeRes().res
  );

describe('DELETE /api/data-lakes/[id]/files/[fabFileId] - audit attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'owner', isAdmin: false, userTags: [] });
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', createdByUserId: 'owner' });
    h.removeFileFromDataLake.mockResolvedValue({ success: true, fileCount: 1, totalSizeBytes: 10 });
  });

  const actor = () => h.removeFileFromDataLake.mock.calls[0][0] as { auditPrincipal?: unknown; userId: string };

  it('hands the service the resolved access context, so the removal names a principal at all', async () => {
    await run();
    expect(actor()).toMatchObject({ userId: 'owner', isAdmin: false });
  });

  it('attaches the KEY as the audit principal for an API-key request', async () => {
    await run({ apiKeyInfo: { keyId: 'key-abc' } });
    expect(actor().auditPrincipal).toEqual({
      principalKind: 'apiKey',
      principalId: 'key-abc',
      onBehalfOfUserId: 'owner',
    });
  });

  it('attaches none for a session request, leaving the service derivation alone', async () => {
    await run({ apiKeyInfo: undefined });
    expect(actor().auditPrincipal).toBeUndefined();
  });
});
