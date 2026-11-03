import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getSignedUrl: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ get: (handler: unknown) => handler }),
}));
vi.mock('@bike4mind/database', () => ({
  FabFile: { findOne: () => ({ lean: async () => ({ _id: 'file-1', moderationStatus: 'clean' }) }) },
  fabFileRepository: { shareable: { findAccessibleById: async () => true } },
}));
vi.mock('@server/dataLakes', () => ({
  resolveAccessibleLakes: vi.fn(async () => []),
  isFileInAccessibleLake: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getSignedUrl: h.getSignedUrl }),
}));

import handlerImpl from '../presigned-url';

const handler = handlerImpl as unknown as (req: unknown, res: unknown) => Promise<void>;

async function call(expiresIn?: string) {
  const json = vi.fn();
  await handler({ query: { 'filePaths[]': ['owned/report.txt'], expiresIn }, user: { id: 'owner' } }, { json });
  return json;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getSignedUrl.mockResolvedValue('https://signed.example.invalid/report.txt');
});

describe('presigned-url expiry bounds', () => {
  it('defaults to one hour when expiresIn is omitted', async () => {
    const json = await call(undefined);
    expect(h.getSignedUrl).toHaveBeenCalledWith(
      'owned/report.txt',
      'get',
      expect.objectContaining({ expiresIn: 3600 })
    );
    expect(json).toHaveBeenCalledWith({ urls: ['https://signed.example.invalid/report.txt'] });
  });

  it('accepts the maximum', async () => {
    await call('3600');
    expect(h.getSignedUrl).toHaveBeenCalledWith(
      'owned/report.txt',
      'get',
      expect.objectContaining({ expiresIn: 3600 })
    );
  });

  it.each(['3601', '604800', '0', '-5', 'abc'])('rejects expiresIn=%s with a validation error', async value => {
    await expect(call(value)).rejects.toMatchObject({ name: 'ZodError' });
    expect(h.getSignedUrl).not.toHaveBeenCalled();
  });
});
