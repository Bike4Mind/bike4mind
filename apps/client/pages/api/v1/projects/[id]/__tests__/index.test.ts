// @vitest-environment node
/**
 * Route tests for GET/PATCH/DELETE /api/v1/projects/{id}. `baseApi` is stubbed (no DB connect, no auth
 * chain) but `nextRouteForContract` and projectService.get/update are not, so the 404 mapping, body
 * validation and the response drift check run for real against mocked repositories. deleteProject's
 * member-revocation cascade has its own service tests, so it is stubbed here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ProjectResourceSchema } from '@bike4mind/common';

const {
  mockFindAccessibleById,
  mockFindUser,
  mockRateLimitOptions,
  mockFindByIdAndUserId,
  mockUpdate,
  mockDeleteProject,
  mockLogEvent,
} = vi.hoisted(() => ({
  mockFindAccessibleById: vi.fn(),
  mockFindUser: vi.fn(),
  mockRateLimitOptions: vi.fn(),
  mockFindByIdAndUserId: vi.fn(),
  mockUpdate: vi.fn(),
  mockDeleteProject: vi.fn(),
  mockLogEvent: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { end: () => void } }) =>
    res.status(405).end(),
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
    return { get: compose, patch: compose, delete: compose };
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    mockRateLimitOptions(options);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
vi.mock('@server/utils/analyticsLog', () => ({ logEventSafe: mockLogEvent }));
vi.mock('@bike4mind/database', () => ({
  projectRepository: {
    shareable: { findAccessibleById: mockFindAccessibleById },
    findByIdAndUserId: mockFindByIdAndUserId,
    update: mockUpdate,
  },
  userRepository: { findById: mockFindUser },
  sessionRepository: {},
  fabFileRepository: {},
}));
vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<{ projectService: object }>();
  return { ...actual, projectService: { ...actual.projectService, deleteProject: mockDeleteProject } };
});

const { default: handler } = await import('@pages/api/v1/projects/[id]/index');
const rateLimitOptionsAtLoad: unknown = mockRateLimitOptions.mock.calls[0]?.[0];

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const USER = { id: 'u1', groups: [] };
const PROJECT_ID = '65a000000000000000000001';

async function call(method: 'GET' | 'PATCH' | 'DELETE', id: string, body?: object) {
  const { req, res } = createMocks({ method, query: { id }, body });
  Object.assign(req, { user: USER, logger });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
  await (handler as any)(req, res);
  return res;
}

const get = (id: string) => call('GET', id);

async function errorOf(id: string, method: 'GET' | 'PATCH' | 'DELETE' = 'GET', body?: object) {
  try {
    await call(method, id, body);
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

const OWNED_PROJECT = {
  id: PROJECT_ID,
  name: 'Research',
  description: 'desc',
  userId: 'u1',
  sessionIds: [],
  fileIds: [],
  users: [{ userId: 'someone-else', permissions: ['read'] }],
  systemPrompts: [],
  isGlobalRead: false,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('PATCH /api/v1/projects/{id}', () => {
  beforeEach(() => {
    mockFindAccessibleById.mockResolvedValue(OWNED_PROJECT);
    mockFindByIdAndUserId.mockResolvedValue(OWNED_PROJECT);
    mockUpdate.mockResolvedValue(undefined);
  });

  it('updates only the fields sent and returns the project through the allowlist', async () => {
    const res = await call('PATCH', PROJECT_ID, { description: 'new desc' });

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(ProjectResourceSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ id: PROJECT_ID, name: 'Research', description: 'new desc' });
    expect(JSON.stringify(body)).not.toMatch(/someone-else|isGlobalRead|systemPrompts|userId/);
    const written = mockUpdate.mock.calls[0][0];
    expect(written).toEqual({ id: PROJECT_ID, description: 'new desc', updatedAt: expect.any(Date) });
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ updatedFields: ['description'] }) }),
      expect.anything(),
      logger
    );
  });

  it('answers 404 for a project only shared with the caller', async () => {
    mockFindByIdAndUserId.mockResolvedValue(null);
    expect((await errorOf(PROJECT_ID, 'PATCH', { name: 'x' })).statusCode).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('treats an empty body as a no-op: no write, no analytics event', async () => {
    const res = await call('PATCH', PROJECT_ID, {});

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ id: PROJECT_ID, name: 'Research', description: 'desc' });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('answers 404 for an empty body on a project only shared with the caller', async () => {
    mockFindByIdAndUserId.mockResolvedValue(null);
    expect((await errorOf(PROJECT_ID, 'PATCH', {})).statusCode).toBe(404);
  });

  it('answers 404 for a malformed or unreadable id', async () => {
    mockFindAccessibleById.mockResolvedValue(null);
    expect((await errorOf('not-an-id', 'PATCH', { name: 'x' })).statusCode).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // baseApi's error handler (stubbed here) renders a ZodError as the 422.
  it.each([[{ users: [] }], [{ name: '' }], [{ systemPrompts: [] }]])('rejects body %j as a 422', async body => {
    expect(((await errorOf(PROJECT_ID, 'PATCH', body)) as { name?: string }).name).toBe('ZodError');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('answers 422 when the new name collides with another live project', async () => {
    mockUpdate.mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    expect((await errorOf(PROJECT_ID, 'PATCH', { name: 'Taken' })).statusCode).toBe(422);
  });
});

describe('DELETE /api/v1/projects/{id}', () => {
  beforeEach(() => {
    mockFindAccessibleById.mockResolvedValue(OWNED_PROJECT);
    mockDeleteProject.mockResolvedValue(OWNED_PROJECT);
  });

  it('deletes the project and answers 204 with no body', async () => {
    const res = await call('DELETE', PROJECT_ID);

    expect(res._getStatusCode()).toBe(204);
    expect(res._getData()).toBe('');
    expect(mockDeleteProject).toHaveBeenCalledWith('u1', { id: PROJECT_ID }, expect.anything());
  });

  it('answers 404 for a project only shared with the caller', async () => {
    // deleteProject's owner-only lookup throws NotFoundError for a sharee.
    const { NotFoundError } = await import('@bike4mind/utils');
    mockDeleteProject.mockRejectedValue(new NotFoundError('Project not found'));
    expect((await errorOf(PROJECT_ID, 'DELETE')).statusCode).toBe(404);
  });

  it('answers 404 for a malformed or unreadable id without deleting anything', async () => {
    mockFindAccessibleById.mockResolvedValue(null);
    expect((await errorOf('not-an-id', 'DELETE')).statusCode).toBe(404);
    expect(mockDeleteProject).not.toHaveBeenCalled();
  });
});
