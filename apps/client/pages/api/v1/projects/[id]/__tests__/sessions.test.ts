// @vitest-environment node
/**
 * Route tests for /api/v1/projects/{id}/sessions and /sessions/{session_id}. `baseApi` is stubbed (no DB
 * connect, no auth chain) but `nextRouteForContract`, projectService and the shared write helpers are
 * not, so the status mapping, cursor handling and response drift check run for real against mocked
 * repositories.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ProjectResourceSchema, ProjectEvents, isZodError } from '@bike4mind/common';

const {
  mockFindAccessibleById,
  mockFindUpdateAccessById,
  mockUpdateWithUpdateAccess,
  mockProjectUpdate,
  mockFindUser,
  mockFindPageByIds,
  mockFindAllAccessibleSessions,
  mockFindAllAccessibleFiles,
  mockSessionUpdate,
  mockFileUpdate,
  mockPublishSummarize,
  mockFilterCredits,
  mockCreateActivity,
  mockLogEvent,
  mockRateLimitOptions,
} = vi.hoisted(() => ({
  mockFindAccessibleById: vi.fn(),
  mockFindUpdateAccessById: vi.fn(),
  mockUpdateWithUpdateAccess: vi.fn(),
  mockProjectUpdate: vi.fn(),
  mockFindUser: vi.fn(),
  mockFindPageByIds: vi.fn(),
  mockFindAllAccessibleSessions: vi.fn(),
  mockFindAllAccessibleFiles: vi.fn(),
  mockSessionUpdate: vi.fn(),
  mockFileUpdate: vi.fn(),
  mockPublishSummarize: vi.fn(),
  mockFilterCredits: vi.fn(),
  mockCreateActivity: vi.fn(),
  mockLogEvent: vi.fn(),
  mockRateLimitOptions: vi.fn(),
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
    return { get: compose, post: compose, delete: compose };
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    mockRateLimitOptions(options);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: mockLogEvent }));
vi.mock('@server/utils/eventBus', () => ({ SessionEvents: { Summarize: { publish: mockPublishSummarize } } }));
vi.mock('@server/utils/sessionOperationalCreditPreflight', () => ({
  filterSessionIdsByOperationalCredits: mockFilterCredits,
}));
vi.mock('@bike4mind/database', () => ({
  projectRepository: {
    shareable: { findAccessibleById: mockFindAccessibleById, findUpdateAccessById: mockFindUpdateAccessById },
    updateWithUpdateAccess: mockUpdateWithUpdateAccess,
    update: mockProjectUpdate,
  },
  userRepository: { findById: mockFindUser },
  fabFileRepository: {
    shareable: { findAllAccessibleByIds: mockFindAllAccessibleFiles },
    update: mockFileUpdate,
  },
  sessionRepository: {
    findPageByIds: mockFindPageByIds,
    shareable: { findAllAccessibleByIds: mockFindAllAccessibleSessions },
    update: mockSessionUpdate,
  },
  activityRepository: { createActivity: mockCreateActivity },
  withTransaction: (fn: () => unknown) => fn(),
}));

const { default: listAddHandler } = await import('@pages/api/v1/projects/[id]/sessions/index');
const { default: removeHandler } = await import('@pages/api/v1/projects/[id]/sessions/[session_id]');
const { encodeCursor, decodeCursor } = await import('@server/utils/cursorPagination');
const rateLimitBuckets = mockRateLimitOptions.mock.calls.map(([options]) => (options as { bucket: string }).bucket);

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const USER = { id: 'u1', groups: [] };
const PROJECT_ID = '65a000000000000000000001';
const SESSION_A = '65c000000000000000000001';
const SESSION_B = '65c000000000000000000002';

type Method = 'GET' | 'POST' | 'DELETE';

async function call(handler: unknown, method: Method, query: Record<string, string>, body?: object) {
  const { req, res } = createMocks({ method, query, body });
  Object.assign(req, { user: USER, logger, ability: {} });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
  await (handler as any)(req, res);
  return res;
}

async function statusOf(handler: unknown, method: Method, query: Record<string, string>, body?: object) {
  try {
    return (await call(handler, method, query, body))._getStatusCode();
  } catch (err) {
    // The real baseApi error handler maps a ZodError to 422; the stubbed chain here rethrows it.
    if (isZodError(err)) return 422;
    return (err as { statusCode?: number }).statusCode;
  }
}

const list = (query: Record<string, string> = {}) => call(listAddHandler, 'GET', { id: PROJECT_ID, ...query });
const add = (body: object) => call(listAddHandler, 'POST', { id: PROJECT_ID }, body);
const remove = (sessionId: string) => call(removeHandler, 'DELETE', { id: PROJECT_ID, session_id: sessionId });

let project: Record<string, unknown>;
const makeProject = (overrides: Record<string, unknown> = {}) => ({
  id: PROJECT_ID,
  name: 'Research',
  description: 'desc',
  userId: 'u1',
  sessionIds: [SESSION_A],
  fileIds: [],
  users: [],
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});
const sessionDoc = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `Session ${id}`,
  userId: 'u1',
  users: [],
  knowledgeIds: [],
  firstCreated: new Date('2026-01-01T00:00:00.000Z'),
  lastUpdated: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  project = makeProject();
  mockFindUser.mockResolvedValue(USER);
  mockFindAccessibleById.mockImplementation(async () => project);
  mockFindUpdateAccessById.mockImplementation(async () => project);
  mockUpdateWithUpdateAccess.mockResolvedValue({ id: PROJECT_ID });
  mockProjectUpdate.mockResolvedValue(undefined);
  mockFindAllAccessibleSessions.mockResolvedValue([]);
  mockFindAllAccessibleFiles.mockResolvedValue([]);
  mockFindPageByIds.mockResolvedValue({ data: [], hasMore: false });
  mockFilterCredits.mockImplementation(async (sessions: { id: string }[]) => new Set(sessions.map(s => s.id)));
  mockPublishSummarize.mockResolvedValue('req-1');
});

describe('rate limiting', () => {
  it('uses one named bucket per method for every project and session id', () => {
    expect(rateLimitBuckets).toEqual(
      expect.arrayContaining([
        'GET /api/v1/projects/[id]/sessions',
        'POST /api/v1/projects/[id]/sessions',
        'DELETE /api/v1/projects/[id]/sessions/[session_id]',
      ])
    );
  });
});

describe('GET /api/v1/projects/{id}/sessions', () => {
  it('returns the public session shape, with no server-owned fields', async () => {
    mockFindPageByIds.mockResolvedValue({
      data: [sessionDoc(SESSION_A, { systemPromptText: 'secret prompt', users: [{ userId: 'x' }] })],
      hasMore: false,
    });

    const res = await list();

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.next_cursor).toBeNull();
    expect(body.data[0]).toMatchObject({ id: SESSION_A, name: `Session ${SESSION_A}`, userId: 'u1' });
    expect(JSON.stringify(body)).not.toMatch(/secret prompt|systemPromptText|"users"/);
    expect(mockFindPageByIds).toHaveBeenCalledWith([SESSION_A], { afterId: undefined, limit: 25 });
  });

  it('answers 404, never 403, for a project the caller cannot read', async () => {
    mockFindAccessibleById.mockResolvedValue(null);
    expect(await statusOf(listAddHandler, 'GET', { id: PROJECT_ID })).toBe(404);
    expect(mockFindPageByIds).not.toHaveBeenCalled();
  });

  it('answers 404 for a malformed project id', async () => {
    mockFindAccessibleById.mockResolvedValue(null);
    expect(await statusOf(listAddHandler, 'GET', { id: 'not-an-id' })).toBe(404);
  });

  it('pages with next_cursor and resumes after the last id served', async () => {
    mockFindPageByIds.mockResolvedValue({ data: [sessionDoc(SESSION_A)], hasMore: true });
    const first = (await list({ limit: '1' }))._getJSONData();

    expect(decodeCursor(first.next_cursor, 'v1.projects.sessions')).toBe(SESSION_A);

    mockFindPageByIds.mockResolvedValue({ data: [sessionDoc(SESSION_B)], hasMore: false });
    const second = (await list({ limit: '1', cursor: first.next_cursor }))._getJSONData();

    expect(mockFindPageByIds).toHaveBeenLastCalledWith([SESSION_A], { afterId: SESSION_A, limit: 1 });
    expect(second.data.map((s: { id: string }) => s.id)).toEqual([SESSION_B]);
    expect(second.next_cursor).toBeNull();
  });

  it.each([
    ['a malformed cursor', 'garbage'],
    ['a cursor issued by another endpoint', encodeCursor('v1.projects.files', SESSION_A)],
    ['a cursor whose id is not an ObjectId', encodeCursor('v1.projects.sessions', 'nope')],
  ])('answers 422 for %s', async (_name, cursor) => {
    expect(await statusOf(listAddHandler, 'GET', { id: PROJECT_ID, cursor })).toBe(422);
    expect(mockFindPageByIds).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/projects/{id}/sessions', () => {
  beforeEach(() => {
    mockFindAllAccessibleSessions.mockResolvedValue([sessionDoc(SESSION_B)]);
  });

  it('adds readable sessions, returns the project allowlist and logs ADD_SESSION', async () => {
    const res = await add({ session_ids: [SESSION_B] });

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(ProjectResourceSchema.safeParse(body).success).toBe(true);
    expect(body.session_ids).toEqual([SESSION_A, SESSION_B]);
    expect(JSON.stringify(body)).not.toMatch(/userId|users/);
    expect(mockUpdateWithUpdateAccess).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ProjectEvents.ADD_SESSION,
        metadata: expect.objectContaining({ contentId: SESSION_B }),
      }),
      expect.anything()
    );
  });

  it('queues a summary billed to the caller when credits allow', async () => {
    await add({ session_ids: [SESSION_B] });

    expect(mockPublishSummarize).toHaveBeenCalledWith({
      sessionId: SESSION_B,
      callTagging: true,
      trigger: 'project',
      payerId: 'u1',
    });
  });

  it('skips the summary but still attaches for a moderated user', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { id: PROJECT_ID }, body: { session_ids: [SESSION_B] } });
    Object.assign(req, { user: { ...USER, isModerated: true }, logger, ability: {} });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
    await (listAddHandler as any)(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockPublishSummarize).not.toHaveBeenCalled();
    expect(mockUpdateWithUpdateAccess).toHaveBeenCalledTimes(1);
  });

  it('skips the summary but still attaches when credits are insufficient', async () => {
    mockFilterCredits.mockResolvedValue(new Set<string>());

    const res = await add({ session_ids: [SESSION_B] });

    expect(res._getStatusCode()).toBe(200);
    expect(mockPublishSummarize).not.toHaveBeenCalled();
    expect(mockUpdateWithUpdateAccess).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a project the caller can only read (read-only sharee)', async () => {
    mockFindUpdateAccessById.mockResolvedValue(null);
    expect(await statusOf(listAddHandler, 'POST', { id: PROJECT_ID }, { session_ids: [SESSION_B] })).toBe(404);
    expect(mockUpdateWithUpdateAccess).not.toHaveBeenCalled();
    expect(mockPublishSummarize).not.toHaveBeenCalled();
  });

  it('answers 404 for a project the caller cannot read, or a malformed id', async () => {
    mockFindAccessibleById.mockResolvedValue(null);
    expect(await statusOf(listAddHandler, 'POST', { id: PROJECT_ID }, { session_ids: [SESSION_B] })).toBe(404);
    expect(await statusOf(listAddHandler, 'POST', { id: 'not-an-id' }, { session_ids: [SESSION_B] })).toBe(404);
  });

  it('answers 400, not the project 404, when none of the sessions is reachable', async () => {
    mockFindAllAccessibleSessions.mockResolvedValue([]);
    expect(await statusOf(listAddHandler, 'POST', { id: PROJECT_ID }, { session_ids: [SESSION_B] })).toBe(400);
    expect(mockPublishSummarize).not.toHaveBeenCalled();
  });

  it('answers 400 when only some of the sessions are reachable', async () => {
    expect(await statusOf(listAddHandler, 'POST', { id: PROJECT_ID }, { session_ids: [SESSION_B, SESSION_A] })).toBe(
      400
    );
    expect(mockUpdateWithUpdateAccess).not.toHaveBeenCalled();
  });

  it.each([
    ['the SPA camelCase spelling', { sessionIds: [SESSION_B] }],
    ['an empty list', { session_ids: [] }],
    ['an unknown field', { session_ids: [SESSION_B], extra: 1 }],
  ])('answers 422 for %s', async (_name, body) => {
    expect(await statusOf(listAddHandler, 'POST', { id: PROJECT_ID }, body)).toBe(422);
    expect(mockFindAccessibleById).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/projects/{id}/sessions/{session_id}', () => {
  const ownSession = sessionDoc(SESSION_A);

  it('removes the session, records the activity and logs REMOVE_SESSION', async () => {
    mockFindAllAccessibleSessions.mockResolvedValue([ownSession]);

    const res = await remove(SESSION_A);

    expect(res._getStatusCode()).toBe(204);
    expect(mockProjectUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: PROJECT_ID, sessionIds: [] }));
    expect(mockCreateActivity).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: ProjectEvents.REMOVE_SESSION }),
      expect.anything()
    );
  });

  it('is a 204 no-op for a readable session that is not in the project', async () => {
    mockFindAllAccessibleSessions.mockResolvedValue([sessionDoc(SESSION_B)]);

    expect((await remove(SESSION_B))._getStatusCode()).toBe(204);
    expect(mockProjectUpdate).toHaveBeenCalledWith(expect.objectContaining({ sessionIds: [SESSION_A] }));
    expect(mockCreateActivity).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('answers 404 for a project the caller cannot read', async () => {
    mockFindAccessibleById.mockResolvedValue(null);
    expect(await statusOf(removeHandler, 'DELETE', { id: PROJECT_ID, session_id: SESSION_A })).toBe(404);
  });

  it('answers 404 for an unreadable session id the project does not hold', async () => {
    mockFindAllAccessibleSessions.mockResolvedValue([]);
    expect(await statusOf(removeHandler, 'DELETE', { id: PROJECT_ID, session_id: SESSION_B })).toBe(404);
    expect(mockProjectUpdate).not.toHaveBeenCalled();
  });

  it('lets the owner clear a held id whose session no longer resolves', async () => {
    mockFindAllAccessibleSessions.mockResolvedValue([]);

    expect((await remove(SESSION_A))._getStatusCode()).toBe(204);
    expect(mockProjectUpdate).toHaveBeenCalledWith(expect.objectContaining({ sessionIds: [] }));
    expect(mockCreateActivity).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a malformed session id without touching the project', async () => {
    expect(await statusOf(removeHandler, 'DELETE', { id: PROJECT_ID, session_id: 'not-an-id' })).toBe(404);
    expect(mockFindAccessibleById).not.toHaveBeenCalled();
  });

  it('answers 403 when the caller owns neither the project nor the session', async () => {
    project = makeProject({ userId: 'someone-else' });
    mockFindAllAccessibleSessions.mockResolvedValue([sessionDoc(SESSION_A, { userId: 'someone-else' })]);

    expect(await statusOf(removeHandler, 'DELETE', { id: PROJECT_ID, session_id: SESSION_A })).toBe(403);
    expect(mockProjectUpdate).not.toHaveBeenCalled();
  });

  it("lets a sharee remove a session they own from someone else's project", async () => {
    project = makeProject({ userId: 'someone-else' });
    mockFindAllAccessibleSessions.mockResolvedValue([ownSession]);

    expect((await remove(SESSION_A))._getStatusCode()).toBe(204);
  });
});
