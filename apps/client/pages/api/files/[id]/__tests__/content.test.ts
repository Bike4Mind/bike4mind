import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotFoundError } from '@bike4mind/common';
import { mintFileContentSig } from '@bike4mind/utils';

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  getSignedUrl: vi.fn(),
  key: Buffer.alloc(32, 3),
  baseApiOptions: undefined as unknown,
  rateLimitOptions: undefined as { subject?: (req: unknown) => string | undefined } | undefined,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions = options;
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => unknown) => ((routes.GET = fn), chain),
    });
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: typeof h.rateLimitOptions) => {
    h.rateLimitOptions = options;
    return vi.fn();
  },
}));
vi.mock('@bike4mind/server-utils/utils/ip', () => ({
  getClientIp: (req: { clientIp?: string }) => req.clientIp,
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getSignedUrl: h.getSignedUrl }),
}));
vi.mock('@bike4mind/database', () => ({ fabFileRepository: { findById: h.findById } }));
vi.mock('@bike4mind/server-utils/files/browserFileSigner', () => ({ fileContentKey: () => h.key }));

import handler from '../content';

const fileId = '0123456789abcdef01234567';
const filePath = 'uploads/u1/photo.png';
const now = new Date('2026-01-02T03:10:00Z');
const exp = Date.parse('2026-01-02T04:00:00Z') / 1000;
const s3Url = (expires: number) =>
  `https://bucket.example.invalid/${filePath}?X-Amz-Date=20260102T031000Z&X-Amz-Expires=${expires}`;

const makeRes = () => {
  const res = {
    headers: {} as Record<string, string>,
    setHeader: vi.fn((name: string, value: string) => void (res.headers[name] = value)),
    redirect: vi.fn(),
  };
  return res;
};

const call = async (query: Record<string, unknown>) => {
  const res = makeRes();
  let error: unknown;
  try {
    await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)({ method: 'GET', query }, res);
  } catch (e) {
    error = e;
  }
  return { res, error };
};

const validQuery = (over: Record<string, unknown> = {}) => ({
  id: fileId,
  exp: String(exp),
  sig: mintFileContentSig({ fileId, filePath, exp }, h.key),
  ...over,
});

const file = (over: Record<string, unknown> = {}) => ({
  id: fileId,
  filePath,
  mimeType: 'image/png',
  moderationStatus: 'clean',
  ...over,
});

describe('GET /api/files/[id]/content', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now });
    h.findById.mockReset().mockResolvedValue(file());
    h.getSignedUrl.mockReset().mockResolvedValue(s3Url(3600));
  });
  afterEach(() => vi.useRealTimers());

  it('is public, GET only', () => {
    expect(h.baseApiOptions).toEqual({ auth: false, allowedMethods: ['GET'] });
  });

  it('counts the rate limit per client IP and file id', () => {
    const subject = h.rateLimitOptions?.subject;
    expect(subject?.({ clientIp: '203.0.113.7', query: { id: fileId } })).toBe(`203.0.113.7:${fileId}`);
    expect(subject?.({ clientIp: '203.0.113.7', query: { id: 'other' } })).not.toBe(`203.0.113.7:${fileId}`);
  });

  it('redirects to a freshly signed S3 link with a bounded private cache', async () => {
    const { res, error } = await call(validQuery());
    expect(error).toBeUndefined();
    expect(h.getSignedUrl).toHaveBeenCalledWith(filePath, 'get', { expiresIn: 3000, audience: 'browser' });
    expect(res.redirect).toHaveBeenCalledWith(302, s3Url(3600));
    // Signed for the 3000s left until token exp 04:00 (now 03:10), not the full hour.
    // min(token exp 04:00, S3 04:10) - now 03:10 - 60s margin = 2940s, capped at 1800.
    expect(res.headers['Cache-Control']).toBe('private, max-age=1800');
    expect(res.headers['Referrer-Policy']).toBe('no-referrer');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('caches no longer than the S3 link lives', async () => {
    h.getSignedUrl.mockResolvedValue(s3Url(900));
    const { res } = await call(validQuery());
    expect(res.headers['Cache-Control']).toBe('private, max-age=840');
  });

  it('caches no longer than the link token lives', async () => {
    vi.setSystemTime((exp - 600) * 1000);
    const { res } = await call(validQuery());
    expect(h.getSignedUrl).toHaveBeenCalledWith(filePath, 'get', { expiresIn: 600, audience: 'browser' });
    expect(res.headers['Cache-Control']).toBe('private, max-age=540');
  });

  it('sends no-store when either expiry is within the margin', async () => {
    h.getSignedUrl.mockResolvedValue(s3Url(30));
    const { res } = await call(validQuery());
    expect(res.redirect).toHaveBeenCalled();
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it.each([
    ['a bad sig', () => validQuery({ sig: mintFileContentSig({ fileId, filePath, exp }, Buffer.alloc(32, 9)) })],
    ['an expired link', () => (vi.setSystemTime(exp * 1000), validQuery())],
    ['a missing sig', () => validQuery({ sig: undefined })],
    [
      'a file moved since minting',
      () => (h.findById.mockResolvedValue(file({ filePath: 'other/path.png' })), validQuery()),
    ],
    ['a deleted file', () => (h.findById.mockResolvedValue(file({ deletedAt: new Date() })), validQuery())],
    ['a pending image', () => (h.findById.mockResolvedValue(file({ moderationStatus: 'pending' })), validQuery())],
    ['a blocked image', () => (h.findById.mockResolvedValue(file({ moderationStatus: 'blocked' })), validQuery())],
    [
      'a legacy row with no moderation status',
      () => (h.findById.mockResolvedValue(file({ moderationStatus: undefined })), validQuery()),
    ],
    ['a row with no file path', () => (h.findById.mockResolvedValue(file({ filePath: undefined })), validQuery())],
    ['an unknown id', () => (h.findById.mockResolvedValue(null), validQuery())],
    ['a malformed id', () => validQuery({ id: 'nope' })],
  ])('answers %s with an uncacheable 404', async (_label, query) => {
    const { res, error } = await call(query());
    expect(error).toBeInstanceOf(NotFoundError);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.redirect).not.toHaveBeenCalled();
    expect(h.getSignedUrl).not.toHaveBeenCalled();
  });

  it('does not query by a malformed id', async () => {
    await call(validQuery({ id: { $ne: null } }));
    expect(h.findById).not.toHaveBeenCalled();
  });
});
