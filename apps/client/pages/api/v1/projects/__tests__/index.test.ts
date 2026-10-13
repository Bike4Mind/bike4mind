// @vitest-environment node
/**
 * Route tests for GET and POST /api/v1/projects. `baseApi` is stubbed (no DB connect, no auth chain)
 * but `nextRouteForContract` and projectService are not, so query/body validation, the response
 * drift check and the service's access checks run for real against mocked repositories. Scope
 * enforcement through the real auth chain lives in scopes.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ListProjectsResponseSchema, ProjectEvents, ProjectResourceSchema } from '@bike4mind/common';

const { mockListAccessibleAfterId, mockCreate, mockFindFiles, mockFindSessions, mockLogEvent } = vi.hoisted(() => ({
  mockListAccessibleAfterId: vi.fn(),
  mockCreate: vi.fn(),
  mockFindFiles: vi.fn(),
  mockFindSessions: vi.fn(),
  mockLogEvent: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { end: () => void } }) =>
    res.status(405).end(),
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
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
vi.mock('@server/utils/analyticsLog', () => ({ logEventSafe: mockLogEvent }));
vi.mock('@bike4mind/database', () => ({
  Project: {},
  projectRepository: { listAccessibleAfterId: mockListAccessibleAfterId, create: mockCreate },
  fabFileRepository: { shareable: { findAllAccessibleByIds: mockFindFiles } },
  sessionRepository: { shareable: { findAllAccessibleByIds: mockFindSessions } },
}));

const { default: handler } = await import('@pages/api/v1/projects/index');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const USER = { id: 'u1', groups: [] };

const FILE_ID = '65b000000000000000000001';
const SESSION_ID = '65c000000000000000000001';
const PUBLIC_KEYS = ['created_at', 'description', 'file_ids', 'id', 'name', 'session_ids', 'updated_at'];

/** A full document as the repository returns it, including every field the public shape must drop. */
const projectDoc = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  _id: id,
  __v: 0,
  name: `Project ${id}`,
  description: 'desc',
  userId: 'u1',
  sessionIds: [SESSION_ID],
  fileIds: [FILE_ID],
  systemPrompts: [{ fileId: FILE_ID, enabled: true }],
  users: [{ userId: 'someone-else', permissions: ['read'] }],
  groups: [{ groupId: 'g1', permissions: ['write'] }],
  isGlobalRead: false,
  isGlobalWrite: false,
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  ...overrides,
});

async function call(options: { method: 'GET' | 'POST'; query?: Record<string, string>; body?: unknown }) {
  const { req, res } = createMocks({ method: options.method, query: options.query ?? {}, body: options.body as never });
  Object.assign(req, { user: USER, logger });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
  await (handler as any)(req, res);
  return res;
}

async function errorOf(
  options: Parameters<typeof call>[0]
): Promise<{ statusCode?: number; name?: string; message?: string }> {
  try {
    await call(options);
  } catch (err) {
    return err as { statusCode?: number; name?: string; message?: string };
  }
  throw new Error('expected the handler to throw');
}

const SENSITIVE_MARKERS = ['someone-else', 'g1', 'systemPrompts', 'isGlobalRead', 'deletedAt', 'userId', '__v'];

beforeEach(() => {
  vi.clearAllMocks();
  mockLogEvent.mockResolvedValue(undefined);
  mockFindFiles.mockImplementation(async (_actor: unknown, ids: string[]) => ids.map(id => ({ id })));
  mockFindSessions.mockImplementation(async (_actor: unknown, ids: string[]) => ids.map(id => ({ id })));
  mockCreate.mockImplementation(async (data: Record<string, unknown>) => projectDoc('65a0000000000000000000ff', data));
});

describe('GET /api/v1/projects', () => {
  it('returns a schema-valid page holding only allowlisted fields', async () => {
    mockListAccessibleAfterId.mockResolvedValue({ data: [projectDoc('65a000000000000000000001')], hasMore: false });

    const res = await call({ method: 'GET' });

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(ListProjectsResponseSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body.data[0]).sort()).toEqual(PUBLIC_KEYS);
    expect(body.data[0]).toMatchObject({
      id: '65a000000000000000000001',
      session_ids: [SESSION_ID],
      file_ids: [FILE_ID],
      created_at: '2026-01-01T00:00:00.000Z',
    });
    for (const marker of SENSITIVE_MARKERS) expect(JSON.stringify(body)).not.toContain(marker);
    expect(body.next_cursor).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('defaults to 25 per page and reads with the caller (id and groups)', async () => {
    mockListAccessibleAfterId.mockResolvedValue({ data: [], hasMore: false });
    await call({ method: 'GET' });
    expect(mockListAccessibleAfterId).toHaveBeenCalledWith(USER, { afterId: undefined, limit: 25 });
  });

  it('mints an opaque cursor from the last id served and resumes after it', async () => {
    mockListAccessibleAfterId.mockResolvedValueOnce({
      data: [projectDoc('65a000000000000000000001'), projectDoc('65a000000000000000000002')],
      hasMore: true,
    });
    const first = (await call({ method: 'GET', query: { limit: '2' } }))._getJSONData();
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(first.next_cursor).not.toContain('65a000000000000000000002');

    mockListAccessibleAfterId.mockResolvedValueOnce({ data: [projectDoc('65a000000000000000000003')], hasMore: false });
    const second = (await call({ method: 'GET', query: { limit: '2', cursor: first.next_cursor } }))._getJSONData();

    expect(mockListAccessibleAfterId).toHaveBeenLastCalledWith(
      USER,
      expect.objectContaining({
        afterId: '65a000000000000000000002',
        limit: 2,
      })
    );
    expect(second.data.map((project: { id: string }) => project.id)).toEqual(['65a000000000000000000003']);
    expect(second.next_cursor).toBeNull();
  });

  it('rejects an out-of-range limit and a malformed or foreign cursor with a 422, before reading', async () => {
    expect((await errorOf({ method: 'GET', query: { limit: '0' } })).name).toBe('ZodError');
    expect((await errorOf({ method: 'GET', query: { limit: '101' } })).name).toBe('ZodError');
    expect((await errorOf({ method: 'GET', query: { cursor: 'not-a-cursor' } })).statusCode).toBe(422);

    const { encodeCursor } = await import('@server/utils/cursorPagination');
    const foreign = encodeCursor('v1.data-lakes', '65a000000000000000000001');
    expect((await errorOf({ method: 'GET', query: { cursor: foreign } })).statusCode).toBe(422);
    const notAnId = encodeCursor('v1.projects', 'not-an-object-id');
    expect((await errorOf({ method: 'GET', query: { cursor: notAnId } })).statusCode).toBe(422);

    expect(mockListAccessibleAfterId).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/projects', () => {
  const body = { name: 'Research', description: 'Q3 notes', session_ids: [SESSION_ID], file_ids: [FILE_ID] };

  it('creates the project and answers 201 with only allowlisted fields', async () => {
    const res = await call({ method: 'POST', body });

    expect(res._getStatusCode()).toBe(201);
    const created = res._getJSONData();
    expect(ProjectResourceSchema.safeParse(created).success).toBe(true);
    expect(Object.keys(created).sort()).toEqual(PUBLIC_KEYS);
    expect(created).toMatchObject({ name: 'Research', session_ids: [SESSION_ID], file_ids: [FILE_ID] });
    for (const marker of SENSITIVE_MARKERS) expect(JSON.stringify(created)).not.toContain(marker);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Research', userId: 'u1', sessionIds: [SESSION_ID], fileIds: [FILE_ID] })
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('emits the same analytics events as the SPA route', async () => {
    await call({ method: 'POST', body });
    const projectId = '65a0000000000000000000ff';
    expect(mockLogEvent).toHaveBeenCalledTimes(3);
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        type: ProjectEvents.CREATE_PROJECT,
        metadata: expect.objectContaining({ projectId }),
      }),
      expect.anything(),
      expect.anything()
    );
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        type: ProjectEvents.ADD_SESSION,
        metadata: expect.objectContaining({ projectId, contentId: SESSION_ID, contentType: 'session' }),
      }),
      expect.anything(),
      expect.anything()
    );
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        type: ProjectEvents.ADD_FILE,
        metadata: expect.objectContaining({ projectId, contentId: FILE_ID, contentType: 'file' }),
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it('answers 422 for a name the caller already uses', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }));
    const error = await errorOf({ method: 'POST', body });
    expect(error.statusCode).toBe(422);
    expect(error.message).toContain('already exists');
  });

  it('answers 400 and creates nothing when a listed file is not readable by the caller', async () => {
    mockFindFiles.mockResolvedValue([]);
    const error = await errorOf({ method: 'POST', body });
    expect(error.statusCode).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects the camelCase SPA spelling instead of silently dropping it', async () => {
    const error = await errorOf({ method: 'POST', body: { name: 'x', description: 'y', fileIds: [FILE_ID] } });
    expect(error.name).toBe('ZodError');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects an empty name or description', async () => {
    expect((await errorOf({ method: 'POST', body: { name: '', description: 'y' } })).name).toBe('ZodError');
    expect((await errorOf({ method: 'POST', body: { name: 'x', description: '' } })).name).toBe('ZodError');
  });
});
