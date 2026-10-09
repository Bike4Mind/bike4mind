// @vitest-environment node
/**
 * Route tests for GET /api/v1/data-lakes. `baseApi` is stubbed (no DB connect, no auth chain) but
 * `nextRouteForContract` is not, so query validation and the response drift check run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { DATA_LAKES, ListDataLakesResponseSchema } from '@bike4mind/common';

const {
  mockListDataLakes,
  mockFindLakes,
  mockComputeStats,
  mockFeatureEnabled,
  mockToMemberAccessContext,
  mockRateLimitOptions,
} = vi.hoisted(() => ({
  mockListDataLakes: vi.fn(),
  mockFindLakes: vi.fn(),
  mockComputeStats: vi.fn(),
  mockFeatureEnabled: { value: true },
  mockToMemberAccessContext: vi.fn(),
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
vi.mock('@server/dataLakes/toAccessContext', () => ({ toMemberAccessContext: mockToMemberAccessContext }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeRepository: { find: mockFindLakes },
  fabFileRepository: { computeDataLakeStats: mockComputeStats },
}));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return { ...actual, dataLakeService: { ...actual.dataLakeService, listDataLakes: mockListDataLakes } };
});

const { default: handler } = await import('@pages/api/v1/data-lakes/index');
// Captured before any beforeEach clears it: the limiter is built once, at module load.
const rateLimitOptionsAtLoad: unknown = mockRateLimitOptions.mock.calls[0]?.[0];

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const MEMBER_CTX = { userId: 'u1', isAdmin: false, userTags: [], organizationIds: [], entitlementKeys: [] };

const lakeConfig = (id: string) => ({
  id,
  name: `Lake ${id}`,
  slug: `lake-${id}`,
  fileTagPrefix: `${id}:`,
  datalakeTag: `datalake:${id}`,
  status: 'active' as const,
});
const lakeDoc = (id: string) => ({
  ...lakeConfig(id),
  fileCount: 2,
  totalSizeBytes: 20,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  systemPrompt: 'editor only',
});

const DB_IDS = ['65a000000000000000000003', '65a000000000000000000001', '65a000000000000000000002'];

function get(query: Record<string, string> = {}) {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user: { id: 'u1', isAdmin: true }, logger });
  return { req, res };
}

async function run(query: Record<string, string> = {}) {
  const { req, res } = get(query);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
  await (handler as any)(req, res);
  return res;
}

async function errorOf(query: Record<string, string>): Promise<{ statusCode?: number; name?: string }> {
  try {
    await run(query);
  } catch (err) {
    return err as { statusCode?: number; name?: string };
  }
  throw new Error('expected the handler to throw');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFeatureEnabled.value = true;
  mockToMemberAccessContext.mockResolvedValue(MEMBER_CTX);
  mockListDataLakes.mockResolvedValue(DB_IDS.map(lakeConfig));
  mockFindLakes.mockImplementation(async (filter: { _id: { $in: string[] } }) => filter._id.$in.map(lakeDoc));
  mockComputeStats.mockResolvedValue({ fileCount: 9, totalSizeBytes: 90, totalChunkedChars: 0 });
});

describe('GET /api/v1/data-lakes', () => {
  it('lists the member reach, even for an admin, as one schema-valid page', async () => {
    const res = await run();
    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(ListDataLakesResponseSchema.safeParse(body).success).toBe(true);
    expect(mockListDataLakes).toHaveBeenCalledWith(MEMBER_CTX, expect.anything());
    expect(body.data.map((lake: { id: string }) => lake.id)).toEqual([...DB_IDS].sort());
    expect(body.next_cursor).toBeNull();
    expect(JSON.stringify(body)).not.toContain('editor only');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns each lake tag, the value a session lakeScope takes', async () => {
    const body = (await run())._getJSONData();
    expect(body.data.map((lake: { datalake_tag: string }) => lake.datalake_tag)).toEqual(
      [...DB_IDS].sort().map(id => `datalake:${id}`)
    );
  });

  it('pages by id with an opaque cursor until next_cursor is null', async () => {
    const first = (await run({ limit: '2' }))._getJSONData();
    expect(first.data).toHaveLength(2);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = (await run({ limit: '2', cursor: first.next_cursor }))._getJSONData();
    expect(second.data.map((lake: { id: string }) => lake.id)).toEqual(['65a000000000000000000003']);
    expect(second.next_cursor).toBeNull();
  });

  it('re-reads documents for only the page it serves', async () => {
    await run({ limit: '1' });
    expect(mockFindLakes).toHaveBeenCalledWith({ _id: { $in: ['65a000000000000000000001'] } });
  });

  it('counts a built-in lake live and nulls its timestamps', async () => {
    const registry = DATA_LAKES[0];
    mockListDataLakes.mockResolvedValue([
      {
        id: registry.id,
        name: registry.name,
        slug: registry.slug,
        fileTagPrefix: registry.fileTagPrefix,
        datalakeTag: registry.datalakeTag,
      },
    ]);
    const body = (await run())._getJSONData();
    expect(mockFindLakes).not.toHaveBeenCalled();
    expect(body.data[0]).toMatchObject({ built_in: true, file_count: 9, total_size_bytes: 90, created_at: null });
  });

  it('rejects an out-of-range limit and a foreign cursor with a 422', async () => {
    expect((await errorOf({ limit: '0' })).name).toBe('ZodError');
    expect((await errorOf({ limit: '101' })).name).toBe('ZodError');
    expect((await errorOf({ cursor: 'not-a-cursor' })).statusCode).toBe(422);
  });

  it('answers 403 FEATURE_DISABLED when Data Lakes are off, before listing anything', async () => {
    mockFeatureEnabled.value = false;
    const res = await run();
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(mockListDataLakes).not.toHaveBeenCalled();
  });

  // Named explicitly for consistency with the id-scoped v1 routes, even though this static route's
  // default pathname bucket would already be stable.
  it('rate-limits on the named static-route bucket', () => {
    expect(rateLimitOptionsAtLoad).toEqual(expect.objectContaining({ bucket: '/api/v1/data-lakes', windowMs: 60_000 }));
  });
});
