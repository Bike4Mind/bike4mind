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
  loadLiveOwner: vi.fn(),
}));
const limitMock = vi.hoisted(() => vi.fn());
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    limitMock(options);
    return (req: unknown, res: unknown, next: () => void) => limitMock(req, res, next);
  },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const middleware: Array<(req: { method: string }, res: unknown, next: () => void) => void> = [];
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const chain = Object.assign(
      async (req: { method: string }, res: unknown) => {
        for (const mw of middleware) {
          let passed = false;
          await mw(req, res, () => {
            passed = true;
          });
          if (!passed) return;
        }
        return handlers[req.method](req, res);
      },
      {
        use: (fn: (req: { method: string }, res: unknown, next: () => void) => void) => (middleware.push(fn), chain),
        get: (fn: (req: unknown, res: unknown) => Promise<unknown>) => ((handlers.GET = fn), chain),
        post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => ((handlers.POST = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/optionalAuth', () => ({
  optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/common', () => ({ CreateAnnotationRequestSchema: { safeParse: vi.fn() } }));
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
  loadLiveOwner: dbMocks.loadLiveOwner,
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

const run = (method = 'GET'): Promise<Res> => {
  const res = makeRes();
  const req = { method, query: { publicId: 'pub1' }, user: undefined, headers: {}, cookies: {} };
  return (handler as unknown as (q: unknown, s: unknown) => Promise<void>)(req, res).then(() => res);
};

const cacheControl = (res: Res) => res.headers['Cache-Control'];

describe('GET annotations list - cache posture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitMock.mockImplementation((_req, _res, next) => next());
    dbMocks.annotationLean.mockResolvedValue([]);
    dbMocks.loadLiveOwner.mockResolvedValue({ name: 'Owner' });
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
    expect(limitMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET' }),
      expect.anything(),
      expect.any(Function)
    );
    expect(limitMock).toHaveBeenCalledTimes(1);
  });

  it('stops a limited GET before reading the artifact or annotations', async () => {
    limitMock.mockImplementation((_req, res: Res) => res.status(429).json({ error: 'Rate limit exceeded' }));

    const res = await run();

    expect(res.statusCode).toBe(429);
    expect(cacheControl(res)).toBe('private, no-store');
    expect(dbMocks.artifactLean).not.toHaveBeenCalled();
    expect(dbMocks.annotationLean).not.toHaveBeenCalled();
  });

  it('does not apply the GET limiter to POST', async () => {
    const res = await run('POST');

    expect(res.statusCode).toBe(401);
    expect(limitMock).not.toHaveBeenCalled();
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

  it('404s when the owner account is gone, banned or suspended', async () => {
    dbMocks.artifactLean.mockResolvedValue({
      publicId: 'pub1',
      visibility: 'public',
      ownerId: 'o1',
      scopeId: 's1',
      commentPolicy: 'open',
      accessGate: null,
    });
    dbMocks.loadLiveOwner.mockResolvedValue(null);

    const res = await run();

    expect(res.statusCode).toBe(404);
    expect(dbMocks.loadLiveOwner).toHaveBeenCalledWith('o1');
    expect(dbMocks.annotationLean).not.toHaveBeenCalled();
  });

  it('leaves a 404 non-cacheable so it cannot poison the shared key', async () => {
    dbMocks.artifactLean.mockResolvedValue(null);

    const res = await run();

    expect(res.statusCode).toBe(404);
    expect(cacheControl(res)).toBe('private, no-store');
  });
});
