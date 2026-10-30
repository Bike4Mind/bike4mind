// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findSessionIdsByImage: vi.fn(),
  findAllAccessibleByIds: vi.fn(),
  download: vi.fn(),
  getMetadata: vi.fn(),
  createFabFile: vi.fn(),
  signUrl: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ use: () => ({ post: (...fns: unknown[]) => fns[fns.length - 1] }) }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: h.signUrl }),
  getGeneratedImageStorage: () => ({ download: h.download, getMetadata: h.getMetadata }),
}));
vi.mock('@bike4mind/services', () => ({
  fabFilesService: { createFabFile: h.createFabFile },
}));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: {},
  FabFile: {},
  User: {},
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
  dataLakeRepository: {},
  withTransaction: (fn: () => Promise<unknown>) => fn(),
  questRepository: { findSessionIdsByImage: h.findSessionIdsByImage },
  sessionRepository: { shareable: { findAllAccessibleByIds: h.findAllAccessibleByIds } },
}));

import handler from '../copy-generated-image';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};

const run = (res: unknown) =>
  (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
    {
      method: 'POST',
      user: { id: 'me', groups: [] },
      ability: {},
      body: { imageS3Key: 'abc.png' },
    } as never,
    res
  );

describe('POST /api/files/copy-generated-image response boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllAccessibleByIds.mockResolvedValue([{ id: 's1' }]);
    h.getMetadata.mockResolvedValue({ contentType: 'image/png' });
    h.download.mockResolvedValue(Buffer.from('image-bytes'));
  });

  it('strips undeclared keys and keeps the signed fileUrl on the serveable-image return', async () => {
    h.signUrl.mockResolvedValue('https://signed.test/img.png');
    h.createFabFile.mockResolvedValue({
      id: 'f1',
      fileName: 'image.png',
      filePath: 'owned/image.png',
      mimeType: 'image/png',
      moderationStatus: 'clean',
      _id: 'raw-object-id',
      __v: 2,
      secretNotInSchema: 'leak',
    });
    const { res, json } = makeRes();

    await run(res);

    const sent = json.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('_id');
    expect(sent).not.toHaveProperty('__v');
    expect(sent).not.toHaveProperty('secretNotInSchema');
    expect(sent).toMatchObject({ id: 'f1', fileName: 'image.png', fileUrl: 'https://signed.test/img.png' });
    expect(sent.fileUrlExpireAt).toBeDefined();
  });

  it('strips undeclared keys on the plain return when the image is not yet serveable', async () => {
    h.createFabFile.mockResolvedValue({
      id: 'f2',
      fileName: 'image.png',
      _id: 'raw-object-id',
      __v: 2,
      secretNotInSchema: 'leak',
    });
    const { res, json } = makeRes();

    await run(res);

    const sent = json.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('_id');
    expect(sent).not.toHaveProperty('__v');
    expect(sent).not.toHaveProperty('secretNotInSchema');
    expect(sent).toMatchObject({ id: 'f2', fileName: 'image.png' });
    expect(sent).not.toHaveProperty('fileUrl');
  });
});
