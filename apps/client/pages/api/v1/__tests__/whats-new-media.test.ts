// @vitest-environment node
/**
 * Route tests for GET /api/v1/whats-new/media/{id}/{asset}. `baseApi` is stubbed (no DB connect) but
 * `nextRouteForContract` is not, so path validation runs for real. Embargo and hidden filtering live in
 * releaseNoteRepository.findPublishedById (ReleaseNoteModel.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindPublishedById, mockFindFile, mockFindFileOptions, mockGetSettings, mockSign, rateLimitOptions } =
  vi.hoisted(() => ({
    mockFindPublishedById: vi.fn(),
    mockFindFile: vi.fn(),
    mockFindFileOptions: vi.fn(),
    mockGetSettings: vi.fn(),
    mockSign: vi.fn(),
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
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    rateLimitOptions.push(options);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  releaseNoteRepository: { findPublishedById: mockFindPublishedById },
  FabFile: {
    findOne: (filter: unknown) => ({
      setOptions: (options: unknown) => {
        mockFindFileOptions(options);
        return { lean: () => mockFindFile(filter) };
      },
    }),
  },
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: mockGetSettings }));
vi.mock('sst', () => ({ Resource: { fabFileBucket: { name: 'files-bucket' } } }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getSignedUrl: mockSign }),
}));

const { default: handler } = await import('@pages/api/v1/whats-new/media/[id]/[asset]');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const NOTE_ID = '65a000000000000000000003';
const UPLOAD = 'https://files-bucket.s3.us-east-2.amazonaws.com/modals/wide.mp4';
const SIGNED = 'https://files-bucket.s3.us-east-2.amazonaws.com/modals/wide.mp4?X-Amz-Signature=abc';
const S3 = 'https://files-bucket.s3.us-east-2.amazonaws.com';
const NOTE = {
  id: NOTE_ID,
  headline: 'Faster search',
  summary: 'Search got quicker.',
  items: [{ category: 'improved', text: 'Search is faster', importance: 1, sourcePrs: [] }],
  video: {
    landscapeUrl: UPLOAD,
    landscapePosterUrl: null,
    portraitUrl: 'https://d111.cloudfront.net/tall.mp4',
    portraitPosterUrl: null,
  },
  image: {
    landscapeUrl: `${S3}/modals/still.png`,
    portraitUrl: `${S3}/modals/still-9x16.png`,
  },
};

function mocks(query: Record<string, string>) {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { logger });
  return { req, res };
}

async function run(query: Record<string, string> = { id: NOTE_ID, asset: 'landscape' }) {
  const { req, res } = mocks(query);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
  await (handler as any)(req, res);
  return res;
}

async function errorOf(
  query: Record<string, string> = { id: NOTE_ID, asset: 'landscape' }
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
  mockFindPublishedById.mockResolvedValue(NOTE);
  mockFindFile.mockResolvedValue({ _id: 'f1', moderationStatus: 'clean' });
  mockSign.mockResolvedValue(SIGNED);
});

describe('GET /api/v1/whats-new/media/{id}/{asset}', () => {
  it('redirects an uploaded file to a signed browser URL, cached for less than the signature lives', async () => {
    const res = await run();
    expect(res._getStatusCode()).toBe(303);
    expect(res._getRedirectUrl()).toBe(SIGNED);
    expect(mockSign).toHaveBeenCalledWith('modals/wide.mp4', 'get', { expiresIn: 3600, audience: 'browser' });
    expect(res.getHeader('Cache-Control')).toBe('public, max-age=600, s-maxage=600');
    expect(mockFindFile).toHaveBeenCalledWith({ filePath: 'modals/wide.mp4' });
  });

  it('redirects image-landscape and image-portrait to signed URLs of the image uploads', async () => {
    for (const [asset, key] of [
      ['image-landscape', 'modals/still.png'],
      ['image-portrait', 'modals/still-9x16.png'],
    ]) {
      const res = await run({ id: NOTE_ID, asset });
      expect(res._getStatusCode()).toBe(303);
      expect(mockSign).toHaveBeenLastCalledWith(key, 'get', { expiresIn: 3600, audience: 'browser' });
    }
  });

  it('404s an image asset on a note that has only a video', async () => {
    mockFindPublishedById.mockResolvedValue({ ...NOTE, image: undefined });
    expect((await errorOf({ id: NOTE_ID, asset: 'image-landscape' })).statusCode).toBe(404);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('404s an image upload that moderation holds or blocks', async () => {
    mockFindFile.mockResolvedValueOnce({ _id: 'f1', moderationStatus: 'blocked' });
    expect((await errorOf({ id: NOTE_ID, asset: 'image-landscape' })).statusCode).toBe(404);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('looks the note up as published now', async () => {
    const before = Date.now();
    await run();
    const [id, now] = mockFindPublishedById.mock.calls[0] as [string, Date];
    expect(id).toBe(NOTE_ID);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('404s a note that is not published', async () => {
    mockFindPublishedById.mockResolvedValueOnce(null);
    const error = await errorOf();
    expect(error.statusCode).toBe(404);
    expect(error.cacheControl).toBeUndefined();
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('404s a note the current denylist withholds from the feed', async () => {
    mockGetSettings.mockResolvedValue({ releaseNotesConfig: JSON.stringify({ enabled: true, denylist: ['search'] }) });
    expect((await errorOf()).statusCode).toBe(404);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('404s while release notes are disabled or the config is malformed, without reading the note', async () => {
    mockGetSettings.mockResolvedValue({ releaseNotesConfig: JSON.stringify({ enabled: false }) });
    expect((await errorOf()).statusCode).toBe(404);
    mockGetSettings.mockResolvedValue({ releaseNotesConfig: '{not json' });
    expect((await errorOf()).statusCode).toBe(404);
    expect(mockFindPublishedById).not.toHaveBeenCalled();
  });

  it('404s an asset the note does not have, and a linked URL it does not serve', async () => {
    expect((await errorOf({ id: NOTE_ID, asset: 'portrait-poster' })).statusCode).toBe(404);
    expect((await errorOf({ id: NOTE_ID, asset: 'portrait' })).statusCode).toBe(404);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('404s an upload that was deleted', async () => {
    mockFindFile.mockResolvedValueOnce({ _id: 'f1', moderationStatus: 'clean', deletedAt: new Date() });
    expect((await errorOf()).statusCode).toBe(404);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('sees soft-deleted uploads, which the soft-delete plugin hides by default', async () => {
    await run();
    expect(mockFindFileOptions).toHaveBeenCalledWith({ includeDeleted: true });
  });

  it('signs an untracked upload under modals/, as /api/files/presigned-url does', async () => {
    mockFindFile.mockResolvedValueOnce(null);
    const res = await run();
    expect(res._getStatusCode()).toBe(303);
    expect(mockSign).toHaveBeenCalledWith('modals/wide.mp4', 'get', { expiresIn: 3600, audience: 'browser' });
  });

  it('404s an upload that moderation holds or blocks', async () => {
    mockFindFile.mockResolvedValueOnce({ _id: 'f1', moderationStatus: 'pending' });
    expect((await errorOf()).statusCode).toBe(404);
    expect(mockSign).not.toHaveBeenCalled();
  });

  // A raw ZodError is what baseApi's error handler answers with a 422.
  it('rejects an unknown asset as a validation error', async () => {
    expect((await errorOf({ id: NOTE_ID, asset: 'secret' })).name).toBe('ZodError');
    expect(mockFindPublishedById).not.toHaveBeenCalled();
  });

  it('rate limits per IP on its own bucket', () => {
    expect(rateLimitOptions).toEqual([{ limit: 300, windowMs: 60_000, bucket: 'GET /api/v1/whats-new/media' }]);
  });
});
