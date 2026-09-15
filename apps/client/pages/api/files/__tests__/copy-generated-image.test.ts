import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  findSessionIdsByImage: vi.fn(),
  findAllByIds: vi.fn(),
  download: vi.fn(),
  getMetadata: vi.fn(),
  createFabFile: vi.fn(),
}));

// The route only calls `.use(...).post(...)`; the ability check in `.use` is not the subject here.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ use: () => ({ post: (handler: unknown) => handler }) }),
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: vi.fn(async () => 'https://s3.test/get') }),
  getGeneratedImageStorage: () => ({ download: h.download, getMetadata: h.getMetadata }),
}));

vi.mock('@bike4mind/services', () => ({
  fabFilesService: { createFabFile: h.createFabFile },
}));

vi.mock('@bike4mind/database', () => ({
  FabFile: {},
  User: {},
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
  dataLakeRepository: {},
  withTransaction: (fn: () => Promise<unknown>) => fn(),
  questRepository: { findSessionIdsByImage: h.findSessionIdsByImage },
  sessionRepository: { findAllByIds: h.findAllByIds },
}));

import handlerImpl from '../copy-generated-image';
const handler = handlerImpl as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

const KEY = '9db8f846-08d5-47d7-9166-a039d3c3d4d7.png';

function makeRes() {
  const json = vi.fn();
  return { res: { json } as unknown as NextApiResponse, json };
}

const req = (userId: string, body: Record<string, unknown> = {}) =>
  ({
    method: 'POST',
    user: { id: userId },
    ability: {},
    body: { imageS3Key: KEY, ...body },
  }) as unknown as NextApiRequest;

describe('POST /api/files/copy-generated-image object-level authz', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getMetadata.mockResolvedValue({ contentType: 'image/png' });
    h.download.mockResolvedValue(Buffer.from('image-bytes'));
    // No filePath on the result -> route returns the record without minting a serve URL.
    h.createFabFile.mockResolvedValue({ id: 'file-1' });
  });

  it('rejects copying an image that belongs to another user - never downloads it', async () => {
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllByIds.mockResolvedValue([{ userId: 'someone-else', users: [] }]);

    const { res } = makeRes();
    await expect(handler(req('me'), res)).rejects.toThrow(/access/i);
    expect(h.download).not.toHaveBeenCalled();
    expect(h.createFabFile).not.toHaveBeenCalled();
  });

  it('copies an image the caller created', async () => {
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllByIds.mockResolvedValue([{ userId: 'me', users: [] }]);

    const { res, json } = makeRes();
    await handler(req('me'), res);

    expect(h.download).toHaveBeenCalledWith(KEY);
    expect(h.createFabFile).toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ id: 'file-1' });
  });

  // createFabFile is mocked here, so this pins only the wiring - which type and precedence the
  // route hands over. What that precedence then resolves to is covered in utils/file.test.ts.
  it('hands createFabFile the stored contentType and claim-first precedence, keeping the caller name', async () => {
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllByIds.mockResolvedValue([{ userId: 'me', users: [] }]);

    const { res } = makeRes();
    await handler(req('me', { fileName: 'notes.txt' }), res);

    expect(h.createFabFile).toHaveBeenCalledWith(
      'me',
      expect.objectContaining({ fileName: 'notes.txt', mimeType: 'image/png' }),
      expect.objectContaining({ mimeTypePrecedence: 'claim-first' })
    );
  });

  // A generic type is no type at all: passed on, claim-first would fall through to the caller's
  // filename and store the image bytes as text/plain.
  it.each(['application/octet-stream', 'binary/octet-stream', undefined])(
    'substitutes PNG for a stored contentType of %s',
    async contentType => {
      h.findSessionIdsByImage.mockResolvedValue(['s1']);
      h.findAllByIds.mockResolvedValue([{ userId: 'me', users: [] }]);
      h.getMetadata.mockResolvedValue({ contentType });

      const { res } = makeRes();
      await handler(req('me', { fileName: 'notes.txt' }), res);

      expect(h.createFabFile).toHaveBeenCalledWith(
        'me',
        expect.objectContaining({ mimeType: 'image/png' }),
        expect.anything()
      );
    }
  );

  // The guard must be tolerant, not exact: a cased or parameterised generic type is still generic.
  it.each(['Application/Octet-Stream', 'application/octet-stream; charset=binary'])(
    'substitutes PNG for a stored contentType of %s (case/parameter tolerant)',
    async contentType => {
      h.findSessionIdsByImage.mockResolvedValue(['s1']);
      h.findAllByIds.mockResolvedValue([{ userId: 'me', users: [] }]);
      h.getMetadata.mockResolvedValue({ contentType });

      const { res } = makeRes();
      await handler(req('me', { fileName: 'notes.txt' }), res);

      expect(h.createFabFile).toHaveBeenCalledWith(
        'me',
        expect.objectContaining({ mimeType: 'image/png' }),
        expect.anything()
      );
    }
  );

  it('keeps a genuine stored contentType like image/webp', async () => {
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllByIds.mockResolvedValue([{ userId: 'me', users: [] }]);
    h.getMetadata.mockResolvedValue({ contentType: 'image/webp' });

    const { res } = makeRes();
    await handler(req('me', { fileName: 'notes.txt' }), res);

    expect(h.createFabFile).toHaveBeenCalledWith(
      'me',
      expect.objectContaining({ mimeType: 'image/webp' }),
      expect.anything()
    );
  });
});
