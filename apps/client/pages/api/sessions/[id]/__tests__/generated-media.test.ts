// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ZodError } from 'zod';
import { NotFoundError } from '@server/utils/errors';

/**
 * The route signs only keys that a quest of an accessible session references: access to the
 * session is the read grant, and a key the session does not reference must look nonexistent.
 * baseApi is stubbed to capture the GET handler, so errors surface as rejections (the real
 * chain maps NotFoundError to 404 and ZodError to 400).
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    get: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: () => chain,
  };
  return { baseApi: () => chain };
});

const findAccessibleById = vi.hoisted(() => vi.fn());
const findGeneratedMediaKeysInSession = vi.hoisted(() => vi.fn());
const getSignedUrl = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({
  sessionRepository: { shareable: { findAccessibleById } },
  questRepository: { findGeneratedMediaKeysInSession },
}));
vi.mock('@server/utils/storage', () => ({ getGeneratedImageStorage: () => ({ getSignedUrl }) }));

import '@pages/api/sessions/[id]/generated-media';

const manyKeys = (count: number) => Array.from({ length: count }, (_, index) => `${index}.png`);

const SESSION_ID = '507f1f77bcf86cd799439011';
const USER = { id: 'user1' };

const call = async (keys: string | string[] | undefined, id: string | null = SESSION_ID) => {
  const query: Record<string, string | string[]> = {};
  if (id !== null) query.id = id;
  if (keys !== undefined) query.keys = keys;
  const { req, res } = createMocks({ method: 'GET', query });
  (req as unknown as { user: typeof USER }).user = USER;
  await mockRefs.getHandler!(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  findAccessibleById.mockResolvedValue({ id: SESSION_ID });
  findGeneratedMediaKeysInSession.mockImplementation(async (_sessionId: string, keys: string[]) => keys);
  getSignedUrl.mockImplementation(async (key: string) => `https://signed.example.invalid/${key}`);
});

describe('GET /api/sessions/[id]/generated-media', () => {
  it('returns presigned urls and an expiry for keys the session references', async () => {
    const before = Date.now();
    const res = await call(['a.png', 'b.mp4']);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData() as { urls: Record<string, string>; expiresAt: string };
    expect(body.urls).toEqual({
      'a.png': 'https://signed.example.invalid/a.png',
      'b.mp4': 'https://signed.example.invalid/b.mp4',
    });
    expect(Date.parse(body.expiresAt)).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(getSignedUrl).toHaveBeenCalledWith('a.png', 'get', { expiresIn: 3600, audience: 'browser' });
  });

  it('accepts a single key as a bare string (one ?keys= occurrence)', async () => {
    const res = await call('a.png');

    expect(res._getStatusCode()).toBe(200);
    expect(findGeneratedMediaKeysInSession).toHaveBeenCalledWith(SESSION_ID, ['a.png']);
    expect((res._getJSONData() as { urls: Record<string, string> }).urls).toEqual({
      'a.png': 'https://signed.example.invalid/a.png',
    });
  });

  it('is a 404 without touching quests or storage when the session is not accessible', async () => {
    findAccessibleById.mockResolvedValue(null);

    await expect(call(['a.png'])).rejects.toBeInstanceOf(NotFoundError);

    expect(findAccessibleById).toHaveBeenCalledWith(USER, SESSION_ID);
    expect(findGeneratedMediaKeysInSession).not.toHaveBeenCalled();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('omits and never signs a key the session does not reference', async () => {
    findGeneratedMediaKeysInSession.mockResolvedValue(['mine.png']);

    const res = await call(['mine.png', 'foreign.png']);

    expect(findGeneratedMediaKeysInSession).toHaveBeenCalledWith(SESSION_ID, ['mine.png', 'foreign.png']);
    expect((res._getJSONData() as { urls: Record<string, string> }).urls).toEqual({
      'mine.png': 'https://signed.example.invalid/mine.png',
    });
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
    expect(getSignedUrl).not.toHaveBeenCalledWith('foreign.png', expect.anything(), expect.anything());
  });

  it('looks quests up by the canonical lowercase session id for an uppercase-hex id', async () => {
    const res = await call(['a.png'], SESSION_ID.toUpperCase());

    expect(res._getStatusCode()).toBe(200);
    expect(findAccessibleById).toHaveBeenCalledWith(USER, SESSION_ID);
    expect(findGeneratedMediaKeysInSession).toHaveBeenCalledWith(SESSION_ID, ['a.png']);
  });

  it('is a 404 for a missing or malformed session id', async () => {
    await expect(call(['a.png'], 'not-a-session-id')).rejects.toBeInstanceOf(NotFoundError);
    await expect(call(['a.png'], null)).rejects.toBeInstanceOf(NotFoundError);
    expect(findAccessibleById).not.toHaveBeenCalled();
  });

  it.each([
    ['a path separator', ['generated/a.png']],
    ['a backslash', ['..\\a.png']],
    ['an empty key', ['']],
    ['an over-long key', ['a'.repeat(257)]],
    ['an empty keys array', []],
    ['more than 50 keys', manyKeys(51)],
    ['no keys param', undefined],
  ])('rejects the query before any lookup: %s', async (_label, keys) => {
    await expect(call(keys)).rejects.toBeInstanceOf(ZodError);

    expect(findAccessibleById).not.toHaveBeenCalled();
    expect(findGeneratedMediaKeysInSession).not.toHaveBeenCalled();
  });

  it('accepts exactly 50 keys', async () => {
    const res = await call(manyKeys(50));
    expect(res._getStatusCode()).toBe(200);
  });
});
