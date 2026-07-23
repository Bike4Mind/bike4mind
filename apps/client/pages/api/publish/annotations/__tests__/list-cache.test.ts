import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * GET /api/publish/annotations/[publicId] - cache posture of the annotation list.
 *
 * The list is deliberately shared-cacheable so the widget's polling fan-out collapses
 * at the CDN, which makes its exact Cache-Control a correctness concern: it previously
 * carried `stale-while-revalidate=60`, so a viewer who had just commented could be
 * served the pre-comment body for another minute and their comment appeared to vanish
 * on reload. Only OPEN-public (public AND ungated) may be cached at all.
 */

const dbMocks = vi.hoisted(() => ({
  artifactLean: vi.fn(),
  annotationLean: vi.fn(),
}));

// The route chains .get(...).post(...), so .get must return the GET handler with a
// .post that swallows the write handler and hands the GET one back - the default
// export is then the GET handler itself.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      use: () => chain,
      get: (fn: object) => Object.assign(fn, { post: () => fn }),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/optionalAuth', () => ({ optionalAuth: () => {} }));
vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: { findOne: () => ({ select: () => ({ lean: dbMocks.artifactLean }) }) },
  Annotation: { find: () => ({ sort: () => ({ lean: dbMocks.annotationLean }) }) },
}));
vi.mock('@server/services/publish', () => ({
  checkVisibility: vi.fn(async () => ({ ok: true })),
  canAnnotate: () => false,
  toPublishUser: () => undefined,
  authorDisplayName: () => 'User',
  toAnnotationDto: (a: unknown) => a,
  requestHasGateProof: () => false,
}));

import handler from '../[publicId]';

type Res = {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  setHeader: (k: string, v: string) => void;
  status: (c: number) => Res;
  json: (o: unknown) => Res;
};

function makeRes(): Res {
  const res = { statusCode: 0, headers: {}, body: undefined } as unknown as Res;
  res.setHeader = (k, v) => {
    res.headers[k] = v;
  };
  res.status = c => {
    res.statusCode = c;
    return res;
  };
  res.json = o => {
    res.body = o;
    return res;
  };
  return res;
}

const run = (): Promise<Res> => {
  const res = makeRes();
  const req = { query: { publicId: 'pub1' }, user: undefined, headers: {}, cookies: {} };
  return (handler as unknown as (q: unknown, s: unknown) => Promise<void>)(req, res).then(() => res);
};

const cacheControl = (res: Res) => res.headers['Cache-Control'];

describe('GET annotations list - cache posture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.annotationLean.mockResolvedValue([]);
  });

  it('shared-caches an open-public list briefly, with no stale-while-revalidate', async () => {
    dbMocks.artifactLean.mockResolvedValue({
      publicId: 'pub1',
      visibility: 'public',
      ownerId: 'o1',
      scopeId: 's1',
      commentPolicy: 'open',
      accessGate: null,
    });

    const res = await run();

    expect(res.statusCode).toBe(200);
    expect(cacheControl(res)).toBe('public, max-age=5, s-maxage=5');
    // A fresh comment must never be maskable by a stale body served from cache.
    expect(cacheControl(res)).not.toContain('stale-while-revalidate');
  });

  it('never caches a gated artifact, even though its visibility is still public', async () => {
    dbMocks.artifactLean.mockResolvedValue({
      publicId: 'pub1',
      visibility: 'public',
      ownerId: 'o1',
      scopeId: 's1',
      commentPolicy: 'open',
      accessGate: { kind: 'passphrase' },
    });

    const res = await run();

    expect(res.statusCode).toBe(200);
    expect(cacheControl(res)).toBe('private, no-store');
  });

  it('never caches a private artifact', async () => {
    dbMocks.artifactLean.mockResolvedValue({
      publicId: 'pub1',
      visibility: 'private',
      ownerId: 'o1',
      scopeId: 's1',
      commentPolicy: 'open',
      accessGate: null,
    });

    const res = await run();

    expect(res.statusCode).toBe(200);
    expect(cacheControl(res)).toBe('private, no-store');
  });

  it('leaves a 404 non-cacheable so it cannot poison the shared key', async () => {
    dbMocks.artifactLean.mockResolvedValue(null);

    const res = await run();

    expect(res.statusCode).toBe(404);
    expect(cacheControl(res)).toBe('private, no-store');
  });
});
