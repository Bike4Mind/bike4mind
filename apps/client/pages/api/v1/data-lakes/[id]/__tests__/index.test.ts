// @vitest-environment node
/**
 * Route tests for GET /api/v1/data-lakes/{id}. `baseApi` is stubbed; the contract prelude and its
 * response drift check run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { DATA_LAKES, DataLakeResourceSchema, NotFoundError } from '@bike4mind/common';

const { mockAssertLakeAccess, mockComputeStats, mockFeatureEnabled, mockRateLimitOptions } = vi.hoisted(() => ({
  mockAssertLakeAccess: vi.fn(),
  mockComputeStats: vi.fn(),
  mockFeatureEnabled: { value: true },
  mockRateLimitOptions: vi.fn(),
}));

// Keeps next-connect's registrar shape and runs `.use()` middleware ahead of each handler, so the
// feature-flag gate is exercised alongside the contract prelude.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    type Mw = (req: unknown, res: unknown, next: () => void) => unknown;
    const used: Mw[] = [];
    const compose =
      (...handlers: Mw[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of [...used, ...handlers]) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = (mw: Mw) => {
      used.push(mw);
      return chain;
    };
    chain.get = compose;
    chain.post = compose;
    chain.delete = compose;
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled:
    () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
      mockFeatureEnabled.value
        ? next()
        : res.status(403).json({ error: 'Feature not available', code: 'FEATURE_DISABLED' }),
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    mockRateLimitOptions(options);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
// Two DISTINCT contexts so a test can tell which builder the route actually called: the admin
// context bypasses lake access and must never reach `assertLakeAccess` on this member-scoped route.
vi.mock('@server/dataLakes/toAccessContext', () => ({
  toAccessContext: async () => ({ userId: 'u1', isAdmin: true, userTags: [], organizationIds: [] }),
  toMemberAccessContext: async () => ({ userId: 'u1', isAdmin: false, userTags: [], organizationIds: [] }),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeRepository: {},
  fabFileRepository: { computeDataLakeStats: mockComputeStats },
}));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return { ...actual, dataLakeService: { ...actual.dataLakeService, assertLakeAccess: mockAssertLakeAccess } };
});

const { default: handler } = await import('@pages/api/v1/data-lakes/[id]/index');
// Captured before any beforeEach clears it: the limiter is built once, at module load.
const rateLimitOptionsAtLoad: unknown = mockRateLimitOptions.mock.calls[0]?.[0];

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const LAKE = {
  id: '65a000000000000000000001',
  name: 'Handbook',
  slug: 'handbook',
  fileTagPrefix: 'hb:',
  datalakeTag: 'datalake:handbook',
  status: 'active',
  fileCount: 4,
  totalSizeBytes: 400,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  systemPrompt: 'editor only',
  requiredUserTag: 'vip',
};

async function run(id: string) {
  const { req, res } = createMocks({ method: 'GET', query: { id } });
  Object.assign(req, { user: { id: 'u1' }, logger });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFeatureEnabled.value = true;
  mockAssertLakeAccess.mockResolvedValue(LAKE);
  mockComputeStats.mockResolvedValue({ fileCount: 9, totalSizeBytes: 90, totalChunkedChars: 0 });
});

describe('GET /api/v1/data-lakes/{id}', () => {
  it('returns the narrow public resource for a lake id or slug', async () => {
    const res = await run('handbook');
    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(DataLakeResourceSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      id: LAKE.id,
      slug: 'handbook',
      datalake_tag: 'datalake:handbook',
      built_in: false,
      file_count: 4,
    });
    expect(JSON.stringify(body)).not.toMatch(/editor only|vip/);
    expect(mockAssertLakeAccess).toHaveBeenCalledWith('handbook', expect.anything(), expect.anything());
    expect(mockComputeStats).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('counts a built-in lake live', async () => {
    const registry = DATA_LAKES[0];
    mockAssertLakeAccess.mockResolvedValue({
      ...registry,
      createdByUserId: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const body = (await run(registry.id))._getJSONData();
    expect(body).toMatchObject({
      built_in: true,
      file_count: 9,
      total_size_bytes: 90,
      created_at: null,
      updated_at: null,
    });
  });

  it('still answers when the built-in lake stats aggregate fails', async () => {
    mockAssertLakeAccess.mockResolvedValue({ ...DATA_LAKES[0], createdByUserId: '' });
    mockComputeStats.mockRejectedValue(new Error('boom'));
    const res = await run(DATA_LAKES[0].id);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ file_count: 0 });
    expect(logger.error).toHaveBeenCalled();
  });

  it('propagates the gate 404 for a lake the caller cannot see', async () => {
    mockAssertLakeAccess.mockRejectedValue(new NotFoundError('Data lake not found'));
    await expect(run('someone-elses')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('answers 403 FEATURE_DISABLED when Data Lakes are off', async () => {
    mockFeatureEnabled.value = false;
    const res = await run('handbook');
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(mockAssertLakeAccess).not.toHaveBeenCalled();
  });

  // Regression for the admin-bypass gap: the public API must never grant a platform admin reach
  // into a lake they are not a member of. Fails if the route resolved `toAccessContext` (isAdmin:
  // true) instead of `toMemberAccessContext` (isAdmin: false).
  it('resolves a member-scoped context, never the admin-bypass one', async () => {
    await run('handbook');
    expect(mockAssertLakeAccess).toHaveBeenCalledWith(
      'handbook',
      expect.objectContaining({ isAdmin: false }),
      expect.anything()
    );
  });

  // The raw pathname embeds `id`; without a stable bucket two different lake ids would each get
  // their own rate-limit counter instead of sharing one budget per caller.
  it('rate-limits on a stable bucket, not the per-id pathname', () => {
    expect(rateLimitOptionsAtLoad).toEqual(
      expect.objectContaining({ bucket: '/api/v1/data-lakes/[id]', windowMs: 60_000 })
    );
  });
});
