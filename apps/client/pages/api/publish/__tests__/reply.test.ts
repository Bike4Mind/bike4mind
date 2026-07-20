import { describe, it, expect, vi, beforeEach } from 'vitest';

// reply.ts wires an Express-style handler at module load and imports server-only deps; stub them
// so we can drive the handler (default export) and the pure deriveTitle helper in isolation.
// parseArtifactsWithFallback is NOT mocked - deriveTitle relies on its real artifact extraction.
const dbMocks = vi.hoisted(() => ({
  questLean: vi.fn(),
  sessionLean: vi.fn(),
  publishedFindOneLean: vi.fn(),
  findOneAndUpdate: vi.fn(),
}));

// baseApi().post(fn) returns fn, so `export default handler` IS the handler function.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, { use: () => chain, post: (fn: unknown) => fn });
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  Quest: { findOne: () => ({ select: () => ({ lean: dbMocks.questLean }) }) },
  Session: { findById: () => ({ select: () => ({ lean: dbMocks.sessionLean }) }) },
  PublishedArtifact: {
    findOne: () => ({ lean: dbMocks.publishedFindOneLean }),
    findOneAndUpdate: dbMocks.findOneAndUpdate,
  },
}));
vi.mock('@server/services/publish', () => ({
  resolveVisibility: () => ({ ok: true, visibility: 'public' }),
  checkScopePermission: () => ({ ok: true }),
  checkPublishQuota: () => ({ ok: true }),
}));

import handler, { deriveTitle } from '../reply';

describe('deriveTitle', () => {
  it('uses the first prose line, stripped of markdown heading markers', () => {
    expect(deriveTitle('# Hello world\n\nmore text')).toBe('Hello world');
  });

  it('prefers prose over a leading artifact block', () => {
    expect(deriveTitle('Intro line\n<artifact type="text/html" title="Tip">y</artifact>')).toBe('Intro line');
  });

  it('falls back to the artifact title when the reply is nothing but an artifact', () => {
    expect(deriveTitle('<artifact type="text/html" title="Tip Calculator">...</artifact>')).toBe('Tip Calculator');
  });

  it('falls back to "Shared reply" when there is no prose and no usable artifact title', () => {
    // No title attribute -> parser assigns "Untitled Artifact", which deriveTitle skips.
    expect(deriveTitle('<artifact type="text/html">y</artifact>')).toBe('Shared reply');
  });

  it('never returns the raw <artifact> wrapper tag as the title (#708)', () => {
    const title = deriveTitle('<artifact type="text/html" title="Real Title"><label>x</label></artifact>');
    expect(title).not.toContain('<artifact');
    expect(title).toBe('Real Title');
  });
});

// Ownership is read from the parent Session (its userId), NOT the Quest - a Quest
// has no top-level userId, so reading it off the Quest silently 403s every
// non-admin (#740).
describe('POST /api/publish/reply - ownership', () => {
  const OWNER = 'owner-user-id';
  type Res = {
    statusCode: number;
    body: unknown;
    status: (code: number) => Res;
    json: (obj: unknown) => Res;
  };
  const makeRes = (): Res => {
    const res = { statusCode: 0, body: undefined as unknown } as Res;
    res.status = (code: number) => {
      res.statusCode = code;
      return res;
    };
    res.json = (obj: unknown) => {
      res.body = obj;
      return res;
    };
    return res;
  };
  const makeReq = (user: Partial<{ id: string; isAdmin: boolean }>) => ({
    user: { id: OWNER, isAdmin: false, organizationId: null, username: 'u', ...user },
    body: { sessionId: 'sess1', messageId: 'msg1' },
    logger: { info: () => {} },
  });
  const run = (req: unknown) => {
    const res = makeRes();
    return (handler as (req: unknown, res: unknown) => Promise<void>)(req, res).then(() => res);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.questLean.mockResolvedValue({ reply: 'Hello world' });
    dbMocks.sessionLean.mockResolvedValue({ userId: OWNER });
    dbMocks.publishedFindOneLean.mockResolvedValue(null);
    dbMocks.findOneAndUpdate.mockResolvedValue({ publicId: 'abc123', slug: 'r-abc123' });
  });

  it('lets a non-admin publish their OWN reply (session owner)', async () => {
    const res = await run(makeReq({ id: OWNER, isAdmin: false }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ publicId: 'abc123', url: '/p/r/abc123' });
  });

  it('returns 403 when a non-admin is not the session owner', async () => {
    dbMocks.sessionLean.mockResolvedValue({ userId: 'someone-else' });
    const res = await run(makeReq({ id: OWNER, isAdmin: false }));
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'You can only publish your own replies' });
  });

  it('lets an admin publish a reply they do not own', async () => {
    dbMocks.sessionLean.mockResolvedValue({ userId: 'someone-else' });
    const res = await run(makeReq({ id: OWNER, isAdmin: true }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ publicId: 'abc123' });
  });

  it('returns 404 when the parent session is missing', async () => {
    dbMocks.sessionLean.mockResolvedValue(null);
    const res = await run(makeReq({ id: OWNER, isAdmin: false }));
    expect(res.statusCode).toBe(404);
  });
});
