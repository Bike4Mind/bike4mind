// @vitest-environment node
/**
 * Route tests for GET /api/v1/whats-new. `baseApi` is stubbed (no DB connect) but
 * `nextRouteForContract` is not, so query validation and the response drift check run for real.
 * Embargo and hidden filtering live in releaseNoteRepository.listPublished (ReleaseNoteModel.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { decodeTimeIdCursor, encodeCursor, encodeTimeIdCursor } from '@server/utils/cursorPagination';

const { mockListPublished, mockGetSettings, rateLimitOptions } = vi.hoisted(() => ({
  mockListPublished: vi.fn(),
  mockGetSettings: vi.fn(),
  rateLimitOptions: [] as unknown[],
}));

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
    return chain;
  },
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(405).json({ error: 'Method not allowed' }),
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    rateLimitOptions.push(options);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  releaseNoteRepository: { listPublished: mockListPublished },
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: mockGetSettings }));

const { default: handler } = await import('@pages/api/v1/whats-new');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const SCOPE = 'v1.whats-new';
const T1 = new Date('2026-02-03T00:00:00.000Z');
const T0 = new Date('2026-02-01T00:00:00.000Z');

// Newest first by (publishAt, id); the first two tie on publishAt.
const NOTES = [
  { id: '65a000000000000000000003', publishAt: T1 },
  { id: '65a000000000000000000002', publishAt: T1 },
  { id: '65a000000000000000000001', publishAt: T0 },
].map(({ id, publishAt }) => ({
  id,
  releaseTag: `tag-${id.slice(-1)}`,
  headline: 'Faster search',
  summary: 'Search got quicker.',
  publishAt,
  items: [{ category: 'improved', text: 'Search is faster', importance: 1, sourcePrs: [4242] }],
  // Internal fields that must never reach the public body.
  deployedSha: 'deadbeefcafe',
  deployedAt: T0,
  status: 'scheduled',
  editedAt: null,
  audience: 'public',
  schemaVersion: 1,
}));

type Keyset = { publishAt: Date; id: string };
const isAfter = (note: Keyset, after?: Keyset) =>
  !after ||
  note.publishAt.getTime() < after.publishAt.getTime() ||
  (note.publishAt.getTime() === after.publishAt.getTime() && note.id < after.id);

function mocks(query: Record<string, string>) {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { logger });
  return { req, res };
}

async function run(query: Record<string, string> = {}) {
  const { req, res } = mocks(query);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
  await (handler as any)(req, res);
  return res;
}

async function errorOf(
  query: Record<string, string>
): Promise<{ statusCode?: number; name?: string; cacheControl: unknown }> {
  const { req, res } = mocks(query);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see run()
    await (handler as any)(req, res);
  } catch (err) {
    return { ...(err as { statusCode?: number; name?: string }), cacheControl: res.getHeader('Cache-Control') };
  }
  throw new Error('expected the handler to throw');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSettings.mockResolvedValue({ releaseNotesConfig: JSON.stringify({ enabled: true }) });
  mockListPublished.mockImplementation(async ({ after, limit }: { after?: Keyset; limit: number }) => {
    const rest = NOTES.filter(note => isAfter(note, after));
    return { items: rest.slice(0, limit), hasMore: rest.length > limit };
  });
});

describe('GET /api/v1/whats-new', () => {
  it('serves a schema-valid page of public fields only, publicly cacheable', async () => {
    const res = await run();
    expect(res._getStatusCode()).toBe(200);
    expect(logger.warn).not.toHaveBeenCalled();
    const body = res._getJSONData();
    expect(body.next_cursor).toBeNull();
    expect(body.data[0]).toEqual({
      id: NOTES[0].id,
      release_tag: 'tag-3',
      headline: 'Faster search',
      summary: 'Search got quicker.',
      published_at: T1.toISOString(),
      items: [{ category: 'improved', text: 'Search is faster', importance: 1 }],
    });
    const serialized = JSON.stringify(body);
    for (const leaked of ['deadbeefcafe', '4242', 'deployedAt', 'status', 'editedAt', 'schemaVersion', 'audience']) {
      expect(serialized).not.toContain(leaked);
    }
    expect(res.getHeader('Cache-Control')).toBe('public, s-maxage=300, stale-while-revalidate=600');
  });

  it('passes the request time to listPublished so embargoed notes stay out', async () => {
    const before = Date.now();
    await run();
    const { now } = mockListPublished.mock.calls[0][0] as { now: Date };
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('pages through publishAt ties exactly once by round-tripping next_cursor', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await run(cursor ? { limit: '1', cursor } : { limit: '1' });
      const body = res._getJSONData();
      seen.push(...body.data.map((note: { id: string }) => note.id));
      cursor = body.next_cursor;
    } while (cursor);
    expect(seen).toEqual(NOTES.map(note => note.id));
  });

  it('passes the decoded keyset to the repository', async () => {
    await run({ cursor: encodeTimeIdCursor(SCOPE, { at: T1, id: NOTES[1].id }) });
    expect(mockListPublished).toHaveBeenCalledWith(
      expect.objectContaining({ after: { publishAt: T1, id: NOTES[1].id }, limit: 25 })
    );
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['foreign scope', encodeTimeIdCursor('v1.sessions', { at: T1, id: NOTES[0].id })],
    ['plain id cursor', encodeCursor(SCOPE, NOTES[0].id)],
    ['non-ObjectId id', encodeCursor(SCOPE, `${T1.toISOString()}|abc`)],
    ['bad timestamp', encodeCursor(SCOPE, `yesterday|${NOTES[0].id}`)],
  ])('rejects a %s cursor with a 422 and never caches it', async (_label, cursor) => {
    const err = await errorOf({ cursor });
    expect(err.statusCode).toBe(422);
    expect(err.cacheControl).toBeUndefined();
    expect(mockListPublished).not.toHaveBeenCalled();
  });

  // A raw ZodError is what baseApi's error handler answers with a 422.
  it.each([{ limit: '0' }, { limit: '101' }, { limit: 'ten' }, { cursor: '' }])(
    'rejects %j as a validation error',
    async query => {
      expect((await errorOf(query)).name).toBe('ZodError');
      expect(mockListPublished).not.toHaveBeenCalled();
    }
  );

  it('withholds a note that matches the current denylist but still advances the cursor past it', async () => {
    mockGetSettings.mockResolvedValue({ releaseNotesConfig: { enabled: true, denylist: ['Acme Corp'] } });
    mockListPublished.mockResolvedValue({
      items: [NOTES[0], { ...NOTES[1], items: [{ ...NOTES[1].items[0], text: 'Built for ACME corp' }] }],
      hasMore: true,
    });
    const body = (await run({ limit: '2' }))._getJSONData();
    expect(body.data.map((note: { id: string }) => note.id)).toEqual([NOTES[0].id]);
    expect(decodeTimeIdCursor(body.next_cursor, SCOPE)).toEqual({ at: T1, id: NOTES[1].id });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('withholding'), { id: NOTES[1].id });
  });

  it('serves an empty list without reading notes while the feature is disabled', async () => {
    mockGetSettings.mockResolvedValue({ releaseNotesConfig: null });
    const res = await run();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ data: [], next_cursor: null });
    expect(mockListPublished).not.toHaveBeenCalled();
  });

  it('treats a malformed config as disabled and warns', async () => {
    mockGetSettings.mockResolvedValue({ releaseNotesConfig: '{not json' });
    const res = await run();
    expect(res._getJSONData()).toEqual({ data: [], next_cursor: null });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('rate limits per IP on a fixed bucket', () => {
    expect(rateLimitOptions).toContainEqual({ limit: 60, windowMs: 60_000, bucket: 'GET /api/v1/whats-new' });
  });
});
