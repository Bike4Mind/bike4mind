// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({ find: vi.fn(), sign: vi.fn(), baseApiOptions: [] as unknown[] }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {};
  chain.use = () => chain;
  chain.get = (fn: unknown) => fn;
  return {
    baseApi: (options: unknown) => {
      h.baseApiOptions.push(options);
      return chain;
    },
  };
});
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getSignedUrl: h.sign }),
}));
vi.mock('@server/skillMarket/templateImage', () => ({ findPublicTemplateImage: h.find }));

import handler from '../[slug]';

const call = (slug: unknown) => {
  const { req, res } = createMocks({ method: 'GET', query: { slug } as never });
  return { res, run: () => (handler as unknown as (a: unknown, b: unknown) => Promise<unknown>)(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.sign.mockResolvedValue('https://signed.example/x?sig=1');
});

describe('GET /api/skills/template/image/[slug]', () => {
  it('is a public, GET-only route', () => {
    expect(h.baseApiOptions).toEqual([{ auth: false, allowedMethods: ['GET'] }]);
  });

  it('redirects a public template image to a short-lived signed URL', async () => {
    h.find.mockResolvedValue({ filePath: 'files/img-1.jpg', mimeType: 'image/jpeg', moderationStatus: 'clean' });
    const { res, run } = call('article-bullets');
    await run();

    expect(h.find).toHaveBeenCalledWith('article-bullets');
    expect(h.sign.mock.calls[0][0]).toBe('files/img-1.jpg');
    expect(h.sign.mock.calls[0][2]).toMatchObject({ audience: 'browser', ResponseContentType: 'image/jpeg' });
    expect(h.sign.mock.calls[0][2].expiresIn).toBeLessThanOrEqual(900);
    expect(res.statusCode).toBe(302);
    expect(res._getRedirectUrl()).toBe('https://signed.example/x?sig=1');
    expect(res.getHeader('Cache-Control')).toBe('public, max-age=300');
    expect(res.getHeader('Referrer-Policy')).toBe('no-referrer');
  });

  it('404s a slug with no public image', async () => {
    h.find.mockResolvedValue(null);
    await expect(call('article-bullets').run()).rejects.toMatchObject({ statusCode: 404 });
    expect(h.sign).not.toHaveBeenCalled();
  });

  it.each(['Upper', '-lead', 'trail-', '../x', 'a/b', 'x'.repeat(65), ['a', 'b']])(
    '404s malformed slug %j without a lookup',
    async slug => {
      await expect(call(slug).run()).rejects.toMatchObject({ statusCode: 404 });
      expect(h.find).not.toHaveBeenCalled();
    }
  );
});
