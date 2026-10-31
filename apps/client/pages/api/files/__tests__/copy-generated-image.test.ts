import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  findSessionIdsByImage: vi.fn(),
  findAllAccessibleByIds: vi.fn(),
  download: vi.fn(),
  getMetadata: vi.fn(),
  createFabFile: vi.fn(),
  signUrl: vi.fn(),
  baseApiOptions: undefined as unknown,
}));

// The route only calls `.use(...).post(...)`; the ability check in `.use` is not the subject here.
// Captures the options for the scope-gate test below.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions = options;
    return { use: () => ({ post: (handler: unknown) => handler }) };
  },
}));

vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));

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

import handlerImpl from '../copy-generated-image';
const handler = handlerImpl as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

const KEY = '9db8f846-08d5-47d7-9166-a039d3c3d4d7.png';

function makeRes() {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as unknown as NextApiResponse, json };
}

const req = (userId: string, body: Record<string, unknown> = {}) =>
  ({
    method: 'POST',
    user: { id: userId, groups: ['g1'] },
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
    h.findAllAccessibleByIds.mockResolvedValue([]);

    const { res } = makeRes();
    await expect(handler(req('me'), res)).rejects.toThrow(/access/i);
    expect(h.download).not.toHaveBeenCalled();
    expect(h.createFabFile).not.toHaveBeenCalled();
  });

  it('copies an image the caller created', async () => {
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllAccessibleByIds.mockResolvedValue([{ id: 's1' }]);

    const { res, json } = makeRes();
    await handler(req('me'), res);

    expect(h.findAllAccessibleByIds).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'me', groups: ['g1'] }),
      ['s1'],
      {
        includeDeleted: true,
      }
    );
    expect(h.download).toHaveBeenCalledWith(KEY);
    expect(h.createFabFile).toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ id: 'file-1' });
  });

  // createFabFile is mocked here, so this pins only the wiring - which type and precedence the
  // route hands over. What that precedence then resolves to is covered in utils/file.test.ts.
  it('hands createFabFile the stored contentType and claim-first precedence, keeping the caller name', async () => {
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllAccessibleByIds.mockResolvedValue([{ id: 's1' }]);

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
      h.findAllAccessibleByIds.mockResolvedValue([{ id: 's1' }]);
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
      h.findAllAccessibleByIds.mockResolvedValue([{ id: 's1' }]);
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
    h.findAllAccessibleByIds.mockResolvedValue([{ id: 's1' }]);
    h.getMetadata.mockResolvedValue({ contentType: 'image/webp' });

    const { res } = makeRes();
    await handler(req('me', { fileName: 'notes.txt' }), res);

    expect(h.createFabFile).toHaveBeenCalledWith(
      'me',
      expect.objectContaining({ mimeType: 'image/webp' }),
      expect.anything()
    );
  });

  it('requires files:write at the baseApi route gate', () => {
    expect(h.baseApiOptions).toEqual({ requiredScopes: ['files:write'] });
  });
});

describe('copied file signing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllAccessibleByIds.mockResolvedValue([{ id: 's1' }]);
    h.getMetadata.mockResolvedValue({ contentType: 'image/png' });
    h.download.mockResolvedValue(Buffer.from('image-bytes'));
    h.signUrl.mockResolvedValue('https://objects.example.invalid/get');
  });

  it('signs the clean response for the browser after creation', async () => {
    h.createFabFile.mockResolvedValue({
      id: 'f1',
      filePath: 'owned/image.png',
      mimeType: 'image/png',
      moderationStatus: 'clean',
    });
    const { res } = makeRes();
    await handler(req('me'), res);
    expect(h.signUrl).toHaveBeenCalledWith('owned/image.png', 'get', { expiresIn: 3600, audience: 'browser' });
  });

  it('preserves real hydrated copied-image fields in the signed response', async () => {
    const { FabFile } = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
    const saved = new FabFile({
      fileName: 'copy.png',
      filePath: 'owned/copy.png',
      mimeType: 'image/png',
      moderationStatus: 'clean',
    });
    const original = saved.toJSON();
    h.createFabFile.mockResolvedValue(saved);
    const { res, json } = makeRes();
    await handler(req('me'), res);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        id: original.id,
        fileName: 'copy.png',
        filePath: 'owned/copy.png',
        fileUrl: 'https://objects.example.invalid/get',
      })
    );
    expect(json.mock.calls[0][0]).not.toHaveProperty('_doc');
    expect(saved.toJSON()).toEqual(original);
  });

  it('honors both private service signing modes', async () => {
    h.createFabFile.mockImplementation(async (_user, _params, adapter) => {
      await adapter.storage.generateSignedUrl('owned/file', 600, 'get');
      await adapter.storage.generateSignedUrl('owned/file', 600, 'put');
      return { id: 'f1' };
    });
    const { res } = makeRes();
    await handler(req('me'), res);
    expect(h.signUrl.mock.calls.map(call => call[1])).toEqual(['get', 'put']);
    expect(h.signUrl.mock.calls.every(call => call[2].audience === undefined)).toBe(true);
  });

  it('withholds a pending image without signing', async () => {
    h.createFabFile.mockResolvedValue({
      id: 'f1',
      filePath: 'owned/image.png',
      mimeType: 'image/png',
      moderationStatus: 'pending',
    });
    const { res, json } = makeRes();
    await handler(req('me'), res);
    expect(json.mock.calls[0][0].fileUrl).toBeUndefined();
    expect(h.signUrl).not.toHaveBeenCalled();
  });
});
