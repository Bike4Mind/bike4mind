import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { S3Storage } from '@bike4mind/fab-pipeline';

/**
 * The owner listing must hand out the SAME thumbnail URL on every call within a signing window,
 * or the browser re-downloads every thumbnail on each refetch. Signs with the real S3 presigner
 * (fixture credentials, no network) so the assertion is on the actual URL bytes.
 */

const { aggregate } = vi.hoisted(() => ({ aggregate: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain: Record<string, unknown> & ((req: { method?: string }, res: unknown) => unknown) = Object.assign(
      (req: { method?: string }, res: unknown) => h[req.method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: { aggregate: (...a: unknown[]) => aggregate(...a) },
  Project: { find: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) },
}));

vi.mock('@server/services/publish', () => ({
  buildListVisibilityFilter: () => ({}),
  buildListQuery: () => ({ match: {}, sort: { publishedAt: -1, publicId: 1 } }),
}));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getPublishedArtifactsStorage: () => new S3Storage('example-bucket', 'us-east-2'),
}));

import handler from '../index';

const USER = 'user-1';
const KEY = `publish-thumbnails/own1/${'a'.repeat(64)}.webp`;

async function listThumbnailUrl(): Promise<unknown> {
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as { query: unknown }).query = { mine: 'true' };
  (req as unknown as { user: unknown }).user = { id: USER };
  (req as unknown as { logger: unknown }).logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return (res._getJSONData() as { artifacts: Array<{ thumbnailUrl?: string }> }).artifacts[0]?.thumbnailUrl;
}

beforeEach(() => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'fixture-access-key');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fixture-secret-key');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
  vi.stubEnv('S3_PRESIGN_ENDPOINT', 'https://objects.example.invalid');
  aggregate.mockResolvedValue([
    {
      rows: [{ publicId: 'own1', ownerId: USER, thumbnailKey: KEY }],
      total: [{ n: 1 }],
      byKind: [],
      byVisibility: [],
      byGate: [],
    },
  ]);
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('GET /api/publish/artifacts?mine=true - cacheable thumbnail URLs', () => {
  it('returns a byte-identical thumbnailUrl for two calls in the same window', async () => {
    vi.setSystemTime(new Date('2026-03-04T05:01:00.000Z'));
    const first = await listThumbnailUrl();
    vi.setSystemTime(new Date('2026-03-04T05:14:30.000Z'));
    const second = await listThumbnailUrl();

    expect(typeof first).toBe('string');
    expect(second).toBe(first);
    const url = new URL(first as string);
    expect(url.pathname).toBe(`/example-bucket/${KEY}`);
    expect(url.searchParams.get('X-Amz-Date')).toBe('20260304T050000Z');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('1800');
  });

  it('rotates to a new URL in the next window', async () => {
    vi.setSystemTime(new Date('2026-03-04T05:14:59.000Z'));
    const before = await listThumbnailUrl();
    vi.setSystemTime(new Date('2026-03-04T05:15:00.000Z'));
    const after = await listThumbnailUrl();

    expect(after).not.toBe(before);
    expect(new URL(after as string).searchParams.get('X-Amz-Date')).toBe('20260304T051500Z');
  });
});
