import { describe, it, expect, vi, beforeEach } from 'vitest';

// reply.ts wires an Express-style handler at module load and imports server-only deps; stub them
// so we can drive the handler (default export) and the pure deriveTitle helper in isolation.
// parseArtifactsWithFallback is NOT mocked - deriveTitle relies on its real artifact extraction.
const dbMocks = vi.hoisted(() => ({
  questLean: vi.fn(),
  sessionLean: vi.fn(),
  publishedFindOneLean: vi.fn(),
  publishedFindOne: vi.fn(),
  invalidatePublishCdn: vi.fn(),
  restrictDuplicatePublications: vi.fn(),
  checkPublishQuota: vi.fn(),
  findOneAndUpdate: vi.fn(),
  refund: vi.fn(() => Promise.resolve()),
  consumePublishAction: vi.fn(),
}));
dbMocks.consumePublishAction.mockImplementation(() => Promise.resolve({ refund: dbMocks.refund }));

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
    findOne: (filter: unknown) => {
      dbMocks.publishedFindOne(filter);
      return { sort: () => ({ lean: dbMocks.publishedFindOneLean }) };
    },
    findOneAndUpdate: dbMocks.findOneAndUpdate,
  },
}));
vi.mock('@server/services/publish', () => ({
  resolveVisibility: (_tier: string, visibility?: string) => ({ ok: true, visibility: visibility ?? 'public' }),
  checkScopePermission: () => ({ ok: true }),
}));
// The real settlePublication runs; its own collaborators are stubbed here.
vi.mock('@server/services/publish/checkPublishQuota', () => ({ checkPublishQuota: dbMocks.checkPublishQuota }));
vi.mock('@server/services/publish/invalidatePublishCdn', () => ({
  invalidatePublishCdn: dbMocks.invalidatePublishCdn,
  toCacheTarget: (a: { publicId: string }) => ({ publicId: a.publicId }),
}));
vi.mock('@server/services/publish/restrictDuplicatePublications', () => ({
  restrictDuplicatePublications: dbMocks.restrictDuplicatePublications,
}));
vi.mock('@server/services/publish/publishRateLimit', () => ({ consumePublishAction: dbMocks.consumePublishAction }));

import handler, { deriveTitle, truncateAtWord } from '../reply';

describe('deriveTitle', () => {
  it('cuts a long first line at a word boundary with an ellipsis', () => {
    const line = 'Here is a long answer about everyday conversation habits '.repeat(5).trim();
    const title = deriveTitle(line);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith('...')).toBe(true);
    expect(line.startsWith(title.slice(0, -3))).toBe(true);
    expect(line.charAt(title.length - 3)).toBe(' ');
  });

  it('uses the first prose line, stripped of markdown heading markers', () => {
    expect(deriveTitle('# Hello world\n\nmore text')).toBe('Hello world');
  });

  it('drops inline markdown markers so the page title reads as plain text', () => {
    expect(deriveTitle('## Session 1 Recap: *Tides of the Drowned Crown*\n\nbody')).toBe(
      'Session 1 Recap: Tides of the Drowned Crown'
    );
    expect(deriveTitle('**Weekly summary**\n\nbody')).toBe('Weekly summary');
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

describe('truncateAtWord', () => {
  it('returns short text unchanged', () => {
    expect(truncateAtWord('short title', 120)).toBe('short title');
  });

  it('hard-cuts a single unbroken token that has no usable word boundary', () => {
    expect(truncateAtWord('x'.repeat(200), 20)).toBe(`${'x'.repeat(17)}...`);
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
    dbMocks.checkPublishQuota.mockResolvedValue({ ok: true });
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

  it("counts the publish against the caller's daily allowance, by their account age", async () => {
    const createdAt = new Date('2026-10-20T00:00:00.000Z');
    const req = makeReq({ id: OWNER, isAdmin: false });
    await run({ ...req, user: { ...req.user, createdAt } });
    expect(dbMocks.consumePublishAction).toHaveBeenCalledTimes(1);
    expect(dbMocks.consumePublishAction).toHaveBeenCalledWith({ id: OWNER, isAdmin: false, createdAt });
  });

  it('counts an API-key caller against the key owner, the same allowance a browser session uses', async () => {
    const req = makeReq({ id: OWNER, isAdmin: false });
    await run({ ...req, apiKeyInfo: { keyId: 'key1', scopes: [] } });
    expect(dbMocks.consumePublishAction).toHaveBeenCalledWith(expect.objectContaining({ id: OWNER }));
  });

  it('does not count a publish that was refused before it could be written', async () => {
    dbMocks.sessionLean.mockResolvedValue({ userId: 'someone-else' });
    await run(makeReq({ id: OWNER, isAdmin: false }));
    expect(dbMocks.consumePublishAction).not.toHaveBeenCalled();
  });

  // A b4m_map fence in `renderedBody` refers to places by id only - it must resolve against a
  // snapshot of the reply's citables even after the source Quest is edited or deleted, so the
  // snapshot has to be written at publish time (#3250 follow-up).
  it('stores the reply promptMeta citables on the published artifact', async () => {
    const citables = [
      { id: 'place:1', type: 'web_url', title: 'Barr', metadata: { place: { id: '1', name: 'Barr' } } },
    ];
    dbMocks.questLean.mockResolvedValue({ reply: 'Hello world', promptMeta: { citables } });
    await run(makeReq({ id: OWNER, isAdmin: false }));
    expect(dbMocks.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $set: expect.objectContaining({ citables }) }),
      expect.anything()
    );
  });

  it('stores no citables when the reply has none', async () => {
    dbMocks.questLean.mockResolvedValue({ reply: 'Hello world' });
    await run(makeReq({ id: OWNER, isAdmin: false }));
    expect(dbMocks.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $set: expect.objectContaining({ citables: undefined }) }),
      expect.anything()
    );
  });
});

// Reopening Publish & Share on a published answer and picking Private must act on the link the
// owner already handed out: one record per owner+reply, rewritten in place, CDN purged.
describe('POST /api/publish/reply - re-publish updates the owner record in place', () => {
  const OWNER = 'owner-user-id';
  const EXISTING = {
    _id: 'row1',
    publicId: 'live123',
    slug: 'r-live123',
    tier: 'user',
    scopeId: OWNER,
    visibility: 'public',
  };
  type Res = { statusCode: number; body: unknown; status: (c: number) => Res; json: (o: unknown) => Res };
  const makeRes = (): Res => {
    const res = { statusCode: 0, body: undefined as unknown } as Res;
    res.status = (c: number) => ((res.statusCode = c), res);
    res.json = (o: unknown) => ((res.body = o), res);
    return res;
  };
  const run = (user: { id: string; isAdmin?: boolean }, body: Record<string, unknown> = {}) => {
    const res = makeRes();
    const req = {
      user: { isAdmin: false, organizationId: null, username: 'u', ...user },
      body: { sessionId: 'sess1', messageId: 'msg1', ...body },
      logger: { info: () => {}, warn: () => {} },
    };
    return (handler as (req: unknown, res: unknown) => Promise<void>)(req, res).then(() => res);
  };
  const upsertCall = () =>
    dbMocks.findOneAndUpdate.mock.calls[0] as [Record<string, unknown>, { $set: Record<string, unknown> }];

  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.checkPublishQuota.mockResolvedValue({ ok: true });
    dbMocks.questLean.mockResolvedValue({ reply: 'Hello world' });
    dbMocks.sessionLean.mockResolvedValue({ userId: OWNER });
    // Only the owner has a publication of this reply.
    dbMocks.publishedFindOne.mockImplementation(() => undefined);
    dbMocks.publishedFindOneLean.mockImplementation(async () => {
      const filter = dbMocks.publishedFindOne.mock.calls.at(-1)?.[0] as { ownerId?: string } | undefined;
      return filter?.ownerId === OWNER ? EXISTING : null;
    });
    dbMocks.findOneAndUpdate.mockImplementation(
      async (_filter: unknown, update: { $set: Record<string, unknown> }) => ({
        ...update.$set,
        source: { kind: 'reply' },
      })
    );
  });

  it('switching to Private rewrites the existing record and keeps its link', async () => {
    const res = await run({ id: OWNER }, { visibility: 'private' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ publicId: 'live123', url: '/p/r/live123', visibility: 'private' });
    const [filter, update] = upsertCall();
    expect(filter).toEqual({ _id: 'row1', ownerId: OWNER, deletedAt: null });
    expect(update.$set).toMatchObject({ publicId: 'live123', visibility: 'private', tier: 'user', scopeId: OWNER });
  });

  it('purges the CDN when a public page is downgraded, so the public copy stops serving', async () => {
    await run({ id: OWNER }, { visibility: 'private' });
    expect(dbMocks.invalidatePublishCdn).toHaveBeenCalledWith({ publicId: 'live123' }, expect.anything());
  });

  it('narrows any older duplicate of the same reply to the saved record', async () => {
    await run({ id: OWNER }, { visibility: 'private' });
    expect(dbMocks.restrictDuplicatePublications).toHaveBeenCalledWith(
      expect.objectContaining({ publicId: 'live123', visibility: 'private' }),
      expect.anything()
    );
  });

  it('answers 409, not a duplicate-key 500, when the page is removed between lookup and write', async () => {
    // Models the store: the row is soft-deleted, so the in-place filter matches nothing, and an
    // upsert would re-insert the same _id over it.
    dbMocks.findOneAndUpdate.mockImplementation(async (_f: unknown, _u: unknown, opts: { upsert?: boolean }) => {
      if (opts.upsert) throw Object.assign(new Error('E11000 duplicate key error collection'), { code: 11000 });
      return null;
    });
    const res = await run({ id: OWNER }, { visibility: 'private' });
    expect(res.statusCode).toBe(409);
    expect(dbMocks.restrictDuplicatePublications).not.toHaveBeenCalled();
    // Nothing was published, so the counted action is handed back.
    expect(dbMocks.refund).toHaveBeenCalledTimes(1);
  });

  it('does not purge when nothing public was or is being served', async () => {
    dbMocks.publishedFindOneLean.mockResolvedValue(null);
    await run({ id: OWNER }, { visibility: 'private' });
    expect(dbMocks.invalidatePublishCdn).not.toHaveBeenCalled();
  });

  it('moves a Team page to Private in place instead of minting a second record', async () => {
    dbMocks.publishedFindOneLean.mockResolvedValue({
      ...EXISTING,
      tier: 'organization',
      scopeId: 'org1',
      visibility: 'organization',
    });
    await run({ id: OWNER }, { visibility: 'private' });
    expect(dbMocks.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = upsertCall();
    expect(filter).toMatchObject({ _id: 'row1' });
    expect(update.$set).toMatchObject({ publicId: 'live123', tier: 'user', scopeId: OWNER, visibility: 'private' });
  });

  it("frees the row's OLD Team tier and scope in the quota check, not the requested ones", async () => {
    dbMocks.publishedFindOneLean.mockResolvedValue({ ...EXISTING, tier: 'organization', scopeId: 'org1' });
    await run({ id: OWNER }, { visibility: 'private' });
    expect(dbMocks.checkPublishQuota).toHaveBeenCalledWith(
      expect.objectContaining({ replacing: { tier: 'organization', scopeId: 'org1', slug: 'r-live123' } })
    );
  });

  it('looks up the existing publication by the CALLER as owner, never across users', async () => {
    await run({ id: OWNER });
    expect(dbMocks.publishedFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: OWNER, 'source.messageId': 'msg1', deletedAt: null })
    );
  });

  it('an admin publishing the same reply never touches the owner record', async () => {
    const res = await run({ id: 'admin-id', isAdmin: true }, { visibility: 'private' });
    expect(res.statusCode).toBe(200);
    expect(dbMocks.publishedFindOne).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'admin-id' }));
    const [filter, update] = upsertCall();
    expect(filter).not.toHaveProperty('_id');
    expect(filter).toMatchObject({ tier: 'user', scopeId: 'admin-id' });
    expect(update.$set.publicId).not.toBe('live123');
    expect(dbMocks.invalidatePublishCdn).not.toHaveBeenCalled();
  });

  it('a different non-admin user cannot publish (and so cannot change) the owner reply', async () => {
    const res = await run({ id: 'intruder' }, { visibility: 'private' });
    expect(res.statusCode).toBe(403);
    expect(dbMocks.publishedFindOne).not.toHaveBeenCalled();
    expect(dbMocks.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
