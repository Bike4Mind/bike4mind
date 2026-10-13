import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const h = vi.hoisted(() => ({
  file: undefined as Record<string, unknown> | undefined,
  upload: vi.fn(),
  getSignedUrl: vi.fn(),
  assertRewriteFits: vi.fn(),
  commitContentRewrite: vi.fn(),
  applyEditedText: vi.fn(),
  extractEditableText: vi.fn(),
  edited: 'edited',
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = { use: () => chain, post: (fn: unknown) => fn };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/utils/objectId', () => ({ isValidObjectId: () => true }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload: h.upload, getSignedUrl: h.getSignedUrl }),
}));
vi.mock('@bike4mind/database', () => ({
  FabFile: { findById: () => ({ where: () => h.file }) },
  withTransaction: (fn: () => unknown) => fn(),
  apiKeyRepository: {},
  adminSettingsRepository: {},
  fabFileRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn(async () => ({})) },
  fabFilesService: { assertRewriteFits: h.assertRewriteFits, commitContentRewrite: h.commitContentRewrite },
}));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: vi.fn(async () => [{ id: 'm', backend: 'test' }]),
  getLlmByModel: () => ({
    complete: async (_id: string, _messages: unknown, _options: unknown, cb: (chunks: string[]) => Promise<void>) =>
      cb([h.edited]),
  }),
}));
vi.mock('@client/services/operationsModelService', () => ({ OperationsModelService: {} }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  applyEditedText: h.applyEditedText,
  extractEditableText: h.extractEditableText,
}));

const handler = (await import('../edit')).default as unknown as (req: Request, res: Response) => Promise<unknown>;

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const user = { id: 'u1' };
const makeFile = (mimeType: string) => ({
  _id: 'ff1',
  id: 'ff1',
  userId: 'u1',
  fileName: 'doc',
  filePath: 'files/u1/doc',
  fileSize: 10,
  mimeType,
  moderationStatus: 'clean',
  versions: [],
});
const call = () =>
  handler(
    {
      query: { id: 'ff1' },
      user,
      body: { instruction: 'edit it', applyImmediately: true, model: 'm' },
      logger: { info: vi.fn(), error: vi.fn() },
    } as unknown as Request,
    { json: vi.fn() } as unknown as Response
  );
const QUOTA = 'File size exceeds storage limit';

describe('POST /api/fabfiles/[id]/edit (applyImmediately) storage accounting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.assertRewriteFits.mockResolvedValue(undefined);
    h.commitContentRewrite.mockResolvedValue(true);
    h.getSignedUrl.mockResolvedValue('https://s3/signed');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, text: async () => 'old', arrayBuffer: async () => new ArrayBuffer(4) }))
    );
  });

  describe('text branch', () => {
    beforeEach(() => {
      h.file = makeFile('text/plain');
      h.edited = 'a much longer body';
    });

    it('charges the rewrite through the helper with the new byte size', async () => {
      await call();

      expect(h.assertRewriteFits).toHaveBeenCalledWith(h.file, 18, expect.anything(), user);
      expect(h.commitContentRewrite).toHaveBeenCalledWith(
        expect.objectContaining({ fabFileId: 'ff1', newSize: 18, uploadStartedAt: expect.any(Date) }),
        expect.anything()
      );
    });

    it('refuses growth past the quota with the standard message before uploading', async () => {
      h.assertRewriteFits.mockRejectedValue(new Error(QUOTA));

      await expect(call()).rejects.toThrow(QUOTA);
      expect(h.upload).not.toHaveBeenCalled();
      expect(h.commitContentRewrite).not.toHaveBeenCalled();
    });
  });

  describe('Office branch', () => {
    beforeEach(() => {
      h.file = makeFile(DOCX);
      h.edited = '[1] edited';
      h.extractEditableText.mockResolvedValue('[1] old');
      h.applyEditedText.mockResolvedValue(Buffer.alloc(30));
    });

    it('repoints and charges in one helper call, guarded on the edited filePath', async () => {
      await call();

      expect(h.assertRewriteFits).toHaveBeenCalledWith(h.file, 30, expect.anything(), user);
      const [args] = h.commitContentRewrite.mock.calls[0];
      expect(args).toMatchObject({ fabFileId: 'ff1', newSize: 30, filter: { filePath: 'files/u1/doc' } });
      expect(args.set.filePath).toEqual(h.upload.mock.calls[0][1]);
    });

    it('refuses growth past the quota before uploading the new version', async () => {
      h.assertRewriteFits.mockRejectedValue(new Error(QUOTA));

      await expect(call()).rejects.toThrow(QUOTA);
      expect(h.upload).not.toHaveBeenCalled();
    });

    it('reports a lost repoint race (the helper charged nothing)', async () => {
      h.commitContentRewrite.mockResolvedValue(false);

      await expect(call()).rejects.toThrow('modified by another edit');
    });
  });
});
