// @vitest-environment node
/**
 * Route tests for GET /api/v1/projects/{id}. `baseApi` is stubbed (no DB connect, no auth chain) but
 * `nextRouteForContract` and projectService.get are not, so the 404 mapping and the response drift
 * check run for real against mocked repositories.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ProjectResourceSchema } from '@bike4mind/common';

const { mockFindAccessibleById, mockFindUser, mockRateLimitOptions } = vi.hoisted(() => ({
  mockFindAccessibleById: vi.fn(),
  mockFindUser: vi.fn(),
  mockRateLimitOptions: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    type Mw = (req: unknown, res: unknown, next: () => void) => unknown;
    const compose =
      (...handlers: Mw[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of handlers) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    return { get: compose };
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    mockRateLimitOptions(options);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
vi.mock('@bike4mind/database', () => ({
  projectRepository: { shareable: { findAccessibleById: mockFindAccessibleById } },
  userRepository: { findById: mockFindUser },
}));

const { default: handler } = await import('@pages/api/v1/projects/[id]/index');
const rateLimitOptionsAtLoad: unknown = mockRateLimitOptions.mock.calls[0]?.[0];

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const USER = { id: 'u1', groups: [] };
const PROJECT_ID = '65a000000000000000000001';

async function get(id: string) {
  const { req, res } = createMocks({ method: 'GET', query: { id } });
  Object.assign(req, { user: USER, logger });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
  await (handler as any)(req, res);
  return res;
}

async function errorOf(id: string): Promise<{ statusCode?: number }> {
  try {
    await get(id);
  } catch (err) {
    return err as { statusCode?: number };
  }
  throw new Error('expected the handler to throw');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUser.mockResolvedValue(USER);
});

describe('GET /api/v1/projects/{id}', () => {
  it('returns the project through the allowlist only', async () => {
    mockFindAccessibleById.mockResolvedValue({
      id: PROJECT_ID,
      name: 'Research',
      description: 'desc',
      userId: 'u1',
      sessionIds: [],
      fileIds: ['65b000000000000000000001'],
      systemPrompts: [{ fileId: '65b000000000000000000001', enabled: true }],
      users: [{ userId: 'someone-else', permissions: ['read'] }],
      groups: [],
      isGlobalRead: true,
      isGlobalWrite: false,
      deletedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    const res = await get(PROJECT_ID);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(ProjectResourceSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body).sort()).toEqual([
      'created_at',
      'description',
      'file_ids',
      'id',
      'name',
      'session_ids',
      'updated_at',
    ]);
    expect(JSON.stringify(body)).not.toMatch(/someone-else|isGlobalRead|systemPrompts|userId/);
    expect(mockFindAccessibleById).toHaveBeenCalledWith(USER, PROJECT_ID);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('answers 404, never 403, for a project the caller cannot read', async () => {
    mockFindAccessibleById.mockResolvedValue(null);
    expect((await errorOf(PROJECT_ID)).statusCode).toBe(404);
  });

  it('answers 404 for a malformed id', async () => {
    // The real repository returns null for a non-ObjectId; the route must not turn it into a 422.
    mockFindAccessibleById.mockResolvedValue(null);
    expect((await errorOf('not-an-id')).statusCode).toBe(404);
  });

  it('rate-limits on one bucket for every project id', () => {
    expect(rateLimitOptionsAtLoad).toEqual(expect.objectContaining({ bucket: '/api/v1/projects/[id]' }));
  });
});
