// @vitest-environment node
/**
 * Route tests for GET /api/v1/sessions. `baseApi` is stubbed (no DB connect, no auth chain) but
 * `nextRouteForContract` is not, so query validation and the response drift check run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockListByUserId } = vi.hoisted(() => ({ mockListByUserId: vi.fn() }));

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
    return chain;
  },
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(405).json({ error: 'Method not allowed' }),
}));
vi.mock('@bike4mind/database', () => ({
  agentRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeRepository: {},
  fabFileRepository: {},
  fallbackLakeSettingsRepository: {},
  organizationRepository: {},
  projectRepository: {},
  sessionRepository: { listByUserId: mockListByUserId },
  userRepository: {},
  User: {},
  activityRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ sessionService: {}, dataLakeService: {}, projectService: {} }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/managers/sessionOrigin', () => ({ resolveSessionOrigin: vi.fn() }));
vi.mock('@server/entitlements/surfaceAccess', () => ({ surfaceAccessForRequest: vi.fn() }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: vi.fn() }));
vi.mock('@client/config/activities', () => ({ ActivityType: {} }));

const { default: handler } = await import('@pages/api/v1/sessions/index');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const IDS = ['65a000000000000000000003', '65a000000000000000000002', '65a000000000000000000001'];

const sessionDoc = (id: string) => ({
  id,
  name: `Session ${id}`,
  userId: 'u1',
  knowledgeIds: ['f1'],
  artifactIds: [],
  tags: [{ name: 'tag', strength: 1 }],
  retrievalTags: [],
  lastUsedModel: null,
  firstCreated: new Date('2026-01-01T00:00:00.000Z'),
  lastUpdated: new Date('2026-01-02T00:00:00.000Z'),
  // Server-owned (redacted) and internal (outside the public allowlist) fields that must not leak.
  systemPromptText: 'secret prompt',
  summary: 'internal summary',
  preauthorizedLakeIds: ['lake-1'],
});

function get(query: Record<string, string> = {}, method = 'GET') {
  const { req, res } = createMocks({ method: method as 'GET', query });
  Object.assign(req, { user: { id: 'u1' }, logger });
  return { req, res };
}

async function run(query: Record<string, string> = {}, method = 'GET') {
  const { req, res } = get(query, method);
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
  // Stands in for the repo: honours beforeId and limit over a newest-first id list.
  mockListByUserId.mockImplementation(async ({ beforeId, limit }: { beforeId?: string; limit: number }) =>
    IDS.filter(id => beforeId === undefined || id < beforeId)
      .slice(0, limit)
      .map(sessionDoc)
  );
});

describe('GET /api/v1/sessions', () => {
  it("lists the caller's own sessions as one schema-valid page with only public fields", async () => {
    const res = await run();
    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    // The adapter checks the pre-serialization body against the contract and warns on drift.
    expect(logger.warn).not.toHaveBeenCalled();
    expect(body.data.map((session: { id: string }) => session.id)).toEqual(IDS);
    expect(body.next_cursor).toBeNull();
    expect(body.data[0]).toEqual({
      id: IDS[0],
      _id: IDS[0],
      name: `Session ${IDS[0]}`,
      userId: 'u1',
      knowledgeIds: ['f1'],
      artifactIds: [],
      tags: [{ name: 'tag', strength: 1 }],
      retrievalTags: [],
      lastUsedModel: null,
      firstCreated: '2026-01-01T00:00:00.000Z',
      lastUpdated: '2026-01-02T00:00:00.000Z',
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('secret prompt');
    expect(serialized).not.toContain('internal summary');
    expect(serialized).not.toContain('lake-1');
    expect(mockListByUserId).toHaveBeenCalledWith({
      userId: 'u1',
      search: undefined,
      surface: undefined,
      filters: undefined,
      beforeId: undefined,
      limit: 26,
    });
  });

  it('pages newest first with an opaque cursor until next_cursor is null', async () => {
    const first = (await run({ limit: '2' }))._getJSONData();
    expect(first.data.map((session: { id: string }) => session.id)).toEqual(IDS.slice(0, 2));
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = (await run({ limit: '2', cursor: first.next_cursor }))._getJSONData();
    expect(mockListByUserId).toHaveBeenLastCalledWith(expect.objectContaining({ beforeId: IDS[1], limit: 3 }));
    expect(second.data.map((session: { id: string }) => session.id)).toEqual([IDS[2]]);
    expect(second.next_cursor).toBeNull();
  });

  it('passes the flat filters through to the repository', async () => {
    await run({ search: 'plan', surface: 'notes', origin: 'api' });
    expect(mockListByUserId).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', search: 'plan', surface: 'notes', filters: { origin: 'api' } })
    );
  });

  it('rejects a bad limit, filter or cursor with a 422 before reading', async () => {
    expect((await errorOf({ limit: '0' })).name).toBe('ZodError');
    expect((await errorOf({ limit: '101' })).name).toBe('ZodError');
    expect((await errorOf({ origin: 'carrier-pigeon' })).name).toBe('ZodError');
    expect((await errorOf({ cursor: 'not-a-cursor' })).statusCode).toBe(422);
    // Well-formed envelope, wrong scope: a cursor minted by another endpoint.
    const foreign = Buffer.from(JSON.stringify({ v: 1, s: 'v1.data-lakes', after: IDS[0] })).toString('base64url');
    expect((await errorOf({ cursor: foreign })).statusCode).toBe(422);
    // Right scope, but the id is not an ObjectId.
    const notAnId = Buffer.from(JSON.stringify({ v: 1, s: 'v1.sessions', after: 'nope' })).toString('base64url');
    expect((await errorOf({ cursor: notAnId })).statusCode).toBe(422);
    expect(mockListByUserId).not.toHaveBeenCalled();
  });

  it('answers 405 for a verb the path does not declare', async () => {
    const res = await run({}, 'PATCH');
    expect(res._getStatusCode()).toBe(405);
  });
});
