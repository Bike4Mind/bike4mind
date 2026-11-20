// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockExists, mockSign } = vi.hoisted(() => ({ mockExists: vi.fn(), mockSign: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {};
  chain.use = () => chain;
  chain.get = (fn: unknown) => fn;
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@bike4mind/database', () => ({ ModalModel: { exists: mockExists } }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getSignedUrl: mockSign }),
}));
vi.mock('@client/server/tools/modalImageUrls', () => ({ MODAL_IMAGE_PREFIX: 'modal-images/' }));

import handler from '../[name]';

const NAME = '123e4567-e89b-12d3-a456-426614174000.png';
const call = (name: string) => {
  const { req, res } = createMocks({ method: 'GET', query: { name } });
  return { res, run: () => (handler as unknown as (a: unknown, b: unknown) => Promise<unknown>)(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSign.mockResolvedValue('https://signed.example/x?sig=1');
});

describe('GET /api/modal-images/[name]', () => {
  it('redirects a referenced image to a short-lived signed URL', async () => {
    mockExists.mockResolvedValue({ _id: 'm1' });
    const { res, run } = call(NAME);
    await run();

    expect(mockExists).toHaveBeenCalledWith({ imageUrl: `modal-images/${NAME}` });
    expect(mockSign.mock.calls[0][0]).toBe(`modal-images/${NAME}`);
    expect(mockSign.mock.calls[0][2].expiresIn).toBeLessThanOrEqual(900);
    expect(res.statusCode).toBe(302);
    expect(res._getRedirectUrl()).toBe('https://signed.example/x?sig=1');
    expect(res.getHeader('Cache-Control')).toBe('public, max-age=300');
    expect(res.getHeader('Referrer-Policy')).toBe('no-referrer');
  });

  it('404s an image no modal references', async () => {
    mockExists.mockResolvedValue(null);
    await expect(call(NAME).run()).rejects.toMatchObject({ statusCode: 404 });
    expect(mockSign).not.toHaveBeenCalled();
  });

  it.each(['..%2Fx', '../x.png', 'a.png', `${NAME}/extra`, 'modal-images/x.png'])(
    '404s malformed name %s without a lookup',
    async name => {
      await expect(call(name).run()).rejects.toMatchObject({ statusCode: 404 });
      expect(mockExists).not.toHaveBeenCalled();
    }
  );
});
