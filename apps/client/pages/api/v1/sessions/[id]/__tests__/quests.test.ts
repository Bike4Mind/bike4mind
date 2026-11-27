// @vitest-environment node
/**
 * Route tests for GET /api/v1/sessions/{id}/quests. `baseApi` is stubbed (no DB connect, no auth chain) but
 * records the options `nextRouteForContract` hands it, and the contract adapter itself runs for real, so
 * query validation and the response drift check are exercised.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindAccessibleById, mockFindPageAfter, baseApiOptions } = vi.hoisted(() => ({
  mockFindAccessibleById: vi.fn(),
  mockFindPageAfter: vi.fn(),
  baseApiOptions: [] as Array<Record<string, unknown> | undefined>,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options?: Record<string, unknown>) => {
    baseApiOptions.push(options);
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
    return chain;
  },
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(405).json({ error: 'Method not allowed' }),
}));
vi.mock('@bike4mind/database', () => ({
  questRepository: { findPageAfterBySessionId: mockFindPageAfter },
  sessionRepository: { shareable: { findAccessibleById: mockFindAccessibleById } },
}));

const { default: handler } = await import('@pages/api/v1/sessions/[id]/quests');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const OWNER_ID = '65b000000000000000000001';
const SHAREE_ID = '65b000000000000000000002';
const SESSION_ID = '65c000000000000000000001';
const OTHER_SESSION_ID = '65c000000000000000000002';

// Oldest first. The first two share a timestamp, so paging must break the tie on id.
const QUESTS = [
  { id: '65d000000000000000000001', at: '2026-03-01T10:00:00.000Z' },
  { id: '65d000000000000000000002', at: '2026-03-01T10:00:00.000Z' },
  { id: '65d000000000000000000003', at: '2026-03-01T10:05:00.000Z' },
].map(({ id, at }) => ({
  id,
  sessionId: SESSION_ID,
  prompt: `prompt ${id}`,
  replies: [`reply ${id}`],
  status: 'done' as const,
  type: 'message' as const,
  timestamp: new Date(at),
  createdAt: new Date(at),
  creditsUsed: 3,
  // Stored fields outside the public allowlist, which must not reach the wire.
  promptMeta: { secret: 'internal-meta' },
  fabFileIds: ['f1'],
}));

type Quest = (typeof QUESTS)[number] & {
  pendingAction?: { tool: string; params: Record<string, unknown>; ts: number };
};

function sessionFor(userId: string) {
  return { id: SESSION_ID, userId };
}

async function run({
  sessionId = SESSION_ID,
  query = {},
  user = { id: OWNER_ID },
  apiKeyInfo,
}: {
  sessionId?: string;
  query?: Record<string, string>;
  user?: { id: string };
  apiKeyInfo?: { keyId: string };
} = {}) {
  const { req, res } = createMocks({ method: 'GET', query: { id: sessionId, ...query } });
  Object.assign(req, { user, logger, ...(apiKeyInfo && { apiKeyInfo }) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
  await (handler as any)(req, res);
  return res;
}

async function errorOf(args: Parameters<typeof run>[0]): Promise<{ statusCode?: number; name?: string }> {
  try {
    await run(args);
  } catch (err) {
    return err as { statusCode?: number; name?: string };
  }
  throw new Error('expected the handler to throw');
}

let stored: Quest[];

beforeEach(() => {
  vi.clearAllMocks();
  stored = QUESTS.map(q => ({ ...q }));
  // Session ACL: only the owner and the sharee see SESSION_ID; any other id (unknown, foreign) is null.
  mockFindAccessibleById.mockImplementation(async (user: { id: string }, id: string) =>
    id === SESSION_ID && [OWNER_ID, SHAREE_ID].includes(user.id) ? sessionFor(OWNER_ID) : null
  );
  // Stands in for the repo: oldest first by (timestamp, id), strictly after `after`, at most `limit`.
  mockFindPageAfter.mockImplementation(
    async (_sessionId: string, { limit, after }: { limit: number; after?: { timestamp: Date; id: string } }) =>
      stored
        .filter(
          q =>
            !after ||
            q.timestamp > after.timestamp ||
            (q.timestamp.getTime() === after.timestamp.getTime() && q.id > after.id)
        )
        .slice(0, limit)
  );
});

describe('GET /api/v1/sessions/{id}/quests', () => {
  it('lists the turns oldest first as one schema-valid page with only public fields', async () => {
    const res = await run();
    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    const body = res._getJSONData();
    // The adapter checks the pre-serialization body against the contract and warns on drift.
    expect(logger.warn).not.toHaveBeenCalled();
    expect(body.data.map((quest: { id: string }) => quest.id)).toEqual(QUESTS.map(q => q.id));
    expect(body.next_cursor).toBeNull();
    expect(body.data[0]).toEqual({
      id: QUESTS[0].id,
      prompt: `prompt ${QUESTS[0].id}`,
      reply: `reply ${QUESTS[0].id}`,
      status: 'done',
      type: 'message',
      createdAt: '2026-03-01T10:00:00.000Z',
      creditsUsed: 3,
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('internal-meta');
    expect(serialized).not.toContain('f1');
  });

  it('round-trips the cursor across a timestamp tie and ends with next_cursor null', async () => {
    const first = (await run({ query: { limit: '1' } }))._getJSONData();
    expect(first.data.map((q: { id: string }) => q.id)).toEqual([QUESTS[0].id]);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = (await run({ query: { limit: '1', cursor: first.next_cursor } }))._getJSONData();
    expect(second.data.map((q: { id: string }) => q.id)).toEqual([QUESTS[1].id]);

    const third = (await run({ query: { limit: '1', cursor: second.next_cursor } }))._getJSONData();
    expect(third.data.map((q: { id: string }) => q.id)).toEqual([QUESTS[2].id]);
    expect(third.next_cursor).toBeNull();
    expect(mockFindPageAfter).toHaveBeenLastCalledWith(SESSION_ID, {
      limit: 2,
      after: { timestamp: QUESTS[1].timestamp, id: QUESTS[1].id },
    });
  });

  it('answers 404 for an unknown, foreign or malformed session id without reading quests', async () => {
    for (const sessionId of [OTHER_SESSION_ID, 'not-an-object-id']) {
      expect((await errorOf({ sessionId })).statusCode).toBe(404);
    }
    // A user the session is not shared with.
    expect((await errorOf({ user: { id: '65b0000000000000000000ff' } })).statusCode).toBe(404);
    expect(mockFindPageAfter).not.toHaveBeenCalled();
  });

  it('serves a session shared with the caller', async () => {
    const res = await run({ user: { id: SHAREE_ID } });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().data).toHaveLength(3);
  });

  it('surfaces pendingAction on the turn awaiting approval, to the owner only', async () => {
    const pendingAction = { tool: 'send_email', params: { to: 'a@example.com' }, ts: 1_780_000_000_000 };
    stored[2] = { ...stored[2], status: 'running' as never, pendingAction };

    const owner = (await run())._getJSONData();
    expect(owner.data[2].pendingAction).toEqual(pendingAction);
    expect(owner.data[0]).not.toHaveProperty('pendingAction');

    const sharee = (await run({ user: { id: SHAREE_ID } }))._getJSONData();
    expect(sharee.data[2]).not.toHaveProperty('pendingAction');
  });

  it('reports errorCode only on a failed turn', async () => {
    stored[0] = { ...stored[0], type: 'error', errorCode: 'insufficient_credits' } as never;
    stored[1] = { ...stored[1], errorCode: 'insufficient_credits' } as never;
    const body = (await run())._getJSONData();
    expect(body.data[0].errorCode).toBe('insufficient_credits');
    expect(body.data[1]).not.toHaveProperty('errorCode');
  });

  it('is open to an API key or a JWT, gated on the notebook scopes', async () => {
    // One baseApi per nextRouteForContract call: `auth: true` installs both the key and the JWT chains.
    expect(baseApiOptions[0]).toMatchObject({ auth: true, requiredScopes: ['notebooks:read', 'notebooks:write'] });
    expect((await run({ apiKeyInfo: { keyId: 'k1' } }))._getStatusCode()).toBe(200);
    expect((await run())._getStatusCode()).toBe(200);
  });

  it('rejects a bad limit or cursor with a 422 before reading quests', async () => {
    expect((await errorOf({ query: { limit: '0' } })).name).toBe('ZodError');
    expect((await errorOf({ query: { limit: '101' } })).name).toBe('ZodError');
    expect((await errorOf({ query: { cursor: 'not-a-cursor' } })).statusCode).toBe(422);
    // Well-formed envelope, wrong scope: a cursor minted by another endpoint.
    const foreign = Buffer.from(JSON.stringify({ v: 1, s: 'v1.sessions', after: 'x|y' })).toString('base64url');
    expect((await errorOf({ query: { cursor: foreign } })).statusCode).toBe(422);
    // Right scope, but the position is not (ISO timestamp | ObjectId).
    const notAPosition = Buffer.from(JSON.stringify({ v: 1, s: 'v1.session-quests', after: 'nope' })).toString(
      'base64url'
    );
    expect((await errorOf({ query: { cursor: notAPosition } })).statusCode).toBe(422);
    expect(mockFindPageAfter).not.toHaveBeenCalled();
  });
});
