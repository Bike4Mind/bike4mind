import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  findSessionIdsByImage: vi.fn(),
  findAllAccessibleByIds: vi.fn(),
  download: vi.fn(),
  getMetadata: vi.fn(),
  saveGeneratedAsset: vi.fn(),
  findById: vi.fn(),
  findOne: vi.fn(),
  signUrl: vi.fn(),
  consumeFileUploadBudget: vi.fn(async (_req: unknown, _fileCount: number) => undefined),
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

vi.mock('@server/files/fileUploadBudget', () => ({ consumeFileUploadBudget: h.consumeFileUploadBudget }));

vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: h.signUrl }),
  getGeneratedImageStorage: () => ({ download: h.download, getMetadata: h.getMetadata }),
}));

vi.mock('@bike4mind/services', () => ({ saveGeneratedAsset: h.saveGeneratedAsset }));

vi.mock('@bike4mind/database', () => ({
  organizationRepository: {},
  FabFile: {},
  User: {},
  fabFileRepository: { findById: h.findById, findOne: h.findOne },
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
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    body: { imageS3Key: KEY, ...body },
  }) as unknown as NextApiRequest;

describe('POST /api/files/copy-generated-image object-level authz', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getMetadata.mockResolvedValue({ contentType: 'image/png' });
    h.download.mockResolvedValue(Buffer.from('image-bytes'));
    h.findOne.mockResolvedValue(null);
    h.saveGeneratedAsset.mockResolvedValue({ saved: true, fileId: 'file-1', s3Key: 'k', fileName: 'f.png' });
    // No filePath on the record -> route returns it without minting a serve URL.
    h.findById.mockResolvedValue({ id: 'file-1' });
  });

  it('rejects copying an image that belongs to another user - never downloads it', async () => {
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllAccessibleByIds.mockResolvedValue([]);

    const { res } = makeRes();
    await expect(handler(req('me'), res)).rejects.toThrow(/access/i);
    expect(h.download).not.toHaveBeenCalled();
    expect(h.saveGeneratedAsset).not.toHaveBeenCalled();
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
    expect(h.saveGeneratedAsset).toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ id: 'file-1' });
  });

  it('spends one unit of the allowance for the copy', async () => {
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllAccessibleByIds.mockResolvedValue([{ id: 's1' }]);

    await handler(req('me'), makeRes().res);

    expect(h.consumeFileUploadBudget).toHaveBeenCalledTimes(1);
    expect(h.consumeFileUploadBudget.mock.calls[0][1]).toBe(1);
  });

  it('creates no file when the allowance refuses the copy', async () => {
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllAccessibleByIds.mockResolvedValue([{ id: 's1' }]);
    h.consumeFileUploadBudget.mockRejectedValueOnce(new Error('Upload limit reached'));

    await expect(handler(req('me'), makeRes().res)).rejects.toThrow('Upload limit reached');
    expect(h.saveGeneratedAsset).not.toHaveBeenCalled();
  });

  // saveGeneratedAsset is mocked here, so this pins only the wiring: the seam saves claim-first, so the stored
  // type it is handed outranks the caller's name (covered in saveGeneratedAsset.test.ts).
  it('hands the seam the stored contentType, keeping the caller name', async () => {
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllAccessibleByIds.mockResolvedValue([{ id: 's1' }]);

    const { res } = makeRes();
    await handler(req('me', { fileName: 'notes.txt' }), res);

    expect(h.saveGeneratedAsset).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'me', fileName: 'notes.txt', contentType: 'image/png' }),
      expect.anything()
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

      expect(h.saveGeneratedAsset).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: 'image/png' }),
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

      expect(h.saveGeneratedAsset).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: 'image/png' }),
        expect.anything()
      );
    }
  );

  it('substitutes PNG for a stored image type with no known extension', async () => {
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllAccessibleByIds.mockResolvedValue([{ id: 's1' }]);
    h.getMetadata.mockResolvedValue({ contentType: 'image/avif' });

    await handler(req('me'), makeRes().res);

    expect(h.saveGeneratedAsset).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'image/png' }),
      expect.anything()
    );
  });

  it('keeps a genuine stored contentType like image/webp', async () => {
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllAccessibleByIds.mockResolvedValue([{ id: 's1' }]);
    h.getMetadata.mockResolvedValue({ contentType: 'image/webp' });

    const { res } = makeRes();
    await handler(req('me', { fileName: 'notes.txt' }), res);

    expect(h.saveGeneratedAsset).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'image/webp' }),
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
    h.findOne.mockResolvedValue(null);
    h.saveGeneratedAsset.mockResolvedValue({ saved: true, fileId: 'f1', s3Key: 'k', fileName: 'f.png' });
  });

  it('signs the clean response for the browser after creation', async () => {
    h.findById.mockResolvedValue({
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
    h.findById.mockResolvedValue(saved);
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
    h.saveGeneratedAsset.mockImplementation(async (_params, deps) => {
      await deps.storage.generateSignedUrl('owned/file', 600, 'get');
      await deps.storage.generateSignedUrl('owned/file', 600, 'put');
      return { saved: true, fileId: 'f1', s3Key: 'k', fileName: 'f.png' };
    });
    h.findById.mockResolvedValue({ id: 'f1' });
    const { res } = makeRes();
    await handler(req('me'), res);
    expect(h.signUrl.mock.calls.map(call => call[1])).toEqual(['get', 'put']);
    expect(h.signUrl.mock.calls.every(call => call[2].audience === undefined)).toBe(true);
  });

  it('withholds a pending image without signing', async () => {
    h.findById.mockResolvedValue({
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

describe('copied file provenance', () => {
  const ORIGINAL_REQUEST = { model: 'gpt-image-1', prompt: 'a red fox', n: 2, size: '1024x1024' };
  const ORIGINAL = {
    id: 'orig-1',
    userId: 'me',
    sourceMetadata: {
      sessionId: 's1',
      generation: {
        generator: 'image',
        provider: 'openai',
        modelId: 'gpt-image-1',
        jobId: 'gen-1-0',
        prompt: 'a red fox',
        request: ORIGINAL_REQUEST,
      },
    },
    derivedFrom: [{ fileId: 'a'.repeat(24), role: 'reference' }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllAccessibleByIds.mockResolvedValue([{ id: 's1' }]);
    h.getMetadata.mockResolvedValue({ contentType: 'image/png' });
    h.download.mockResolvedValue(Buffer.from('image-bytes'));
    h.findOne.mockResolvedValue(null);
    h.saveGeneratedAsset.mockResolvedValue({ saved: true, fileId: 'file-1', s3Key: 'k', fileName: 'f.png' });
    h.findById.mockResolvedValue({ id: 'file-1' });
  });

  it("returns the caller's own generated file instead of saving a duplicate", async () => {
    h.findOne.mockResolvedValue(ORIGINAL);

    const { res, json } = makeRes();
    await handler(req('me'), res);

    expect(h.findSessionIdsByImage).toHaveBeenLastCalledWith(KEY);
    expect(h.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        // Keeps the lookup on the partial (TOOL_GENERATED-only) sessionId index.
        sourceType: 'tool_generated',
        'sourceMetadata.sessionId': { $in: ['s1'] },
        'sourceMetadata.generatedOutputKey': KEY,
        deletedAt: null,
      })
    );
    expect(h.findById).toHaveBeenCalledWith('orig-1');
    expect(h.saveGeneratedAsset).not.toHaveBeenCalled();
    expect(h.consumeFileUploadBudget).not.toHaveBeenCalled();
    expect(h.download).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ id: 'file-1' });
  });

  it('carries the original request under a fresh job for a share recipient, without lineage', async () => {
    h.findOne.mockResolvedValue({ ...ORIGINAL, userId: 'owner' });

    await handler(req('me'), makeRes().res);

    const [params] = h.saveGeneratedAsset.mock.calls[0];
    expect(params.generation).toEqual({
      generator: 'image',
      provider: 'openai',
      modelId: 'gpt-image-1',
      prompt: 'a red fox',
      request: ORIGINAL_REQUEST,
    });
    expect(params.generatedOutputKey).toBe(KEY);
    expect(params).not.toHaveProperty('derivedFrom');
  });

  it('saves an image with no recorded generation as a generated image without a request', async () => {
    await handler(req('me'), makeRes().res);

    const [params] = h.saveGeneratedAsset.mock.calls[0];
    expect(params.generation).toEqual({ generator: 'image', provider: 'unknown', prompt: '' });
    expect(params).not.toHaveProperty('derivedFrom');
  });

  it('saves the image unrecorded when the original lookup fails', async () => {
    h.findOne.mockRejectedValue(new Error('db down'));

    await handler(req('me'), makeRes().res);

    const [params] = h.saveGeneratedAsset.mock.calls[0];
    expect(params.generation).toEqual({ generator: 'image', provider: 'unknown', prompt: '' });
  });

  it('fails the request with the refusal itself when the save is refused', async () => {
    const refusal = new Error('Storage limit reached');
    h.saveGeneratedAsset.mockResolvedValue({ saved: false, reason: 'storage_limit', cause: refusal });

    await expect(handler(req('me'), makeRes().res)).rejects.toBe(refusal);
    expect(h.findById).not.toHaveBeenCalled();
  });

  it('keeps promptTruncated on the generation carried to a share recipient', async () => {
    h.findOne.mockResolvedValue({
      ...ORIGINAL,
      userId: 'owner',
      sourceMetadata: {
        ...ORIGINAL.sourceMetadata,
        generation: { ...ORIGINAL.sourceMetadata.generation, promptTruncated: true },
      },
    });

    await handler(req('me'), makeRes().res);

    const [params] = h.saveGeneratedAsset.mock.calls[0];
    expect(params.generation.promptTruncated).toBe(true);
  });

  it('fails with an internal error when the save is refused without a cause', async () => {
    h.saveGeneratedAsset.mockResolvedValue({ saved: false });

    await expect(handler(req('me'), makeRes().res)).rejects.toThrow('Failed to save the image to your files');
    expect(h.findById).not.toHaveBeenCalled();
  });
});
