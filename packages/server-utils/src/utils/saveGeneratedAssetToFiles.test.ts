import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaveGeneratedAssetDeps, SaveGeneratedAssetParams } from '@bike4mind/services';

const mocks = vi.hoisted(() => ({
  saveGeneratedAsset: vi.fn(),
  upload: vi.fn(),
  getSignedUrl: vi.fn(),
  scopedSettingsRepository: { name: 'scopedSettings' },
  findSession: vi.fn(),
  recordObject: vi.fn(),
  findOrganization: vi.fn(),
  lockCreator: vi.fn(),
  createFile: vi.fn(),
  findFile: vi.fn(),
  deleteFile: vi.fn(),
  rememberFileCleanup: vi.fn(),
  deleteRememberedFile: vi.fn(),
}));

vi.mock('@bike4mind/services', () => ({ saveGeneratedAsset: mocks.saveGeneratedAsset }));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: mocks.findOrganization },
  adminSettingsRepository: {},
  dataLakeRepository: {},
  fabFileRepository: { create: mocks.createFile, findOne: mocks.findFile },
  scopedSettingsRepository: mocks.scopedSettingsRepository,
  sessionRepository: { findByIdAndUserId: mocks.findSession },
  recordRetainedGeneratedObject: mocks.recordObject,
  lockRetentionCreator: mocks.lockCreator,
  withTransaction: async (callback: (session: unknown) => Promise<unknown>) => callback({ testTransaction: true }),
  User: {},
}));
vi.mock('./storage/index', () => ({
  getFilesStorage: () => ({
    upload: mocks.upload,
    getSignedUrl: mocks.getSignedUrl,
    deletePermanently: mocks.deleteFile,
  }),
}));

vi.mock('./generatedFileCleanup', () => ({
  rememberGeneratedFileCleanup: mocks.rememberFileCleanup,
  deleteRememberedGeneratedFile: mocks.deleteRememberedFile,
}));
import { saveGeneratedAssetToFiles } from './saveGeneratedAssetToFiles';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const params = (signal?: AbortSignal): SaveGeneratedAssetParams => ({
  userId: 'u1',
  bytes: Buffer.from('v'),
  contentType: 'video/mp4',
  generation: { generator: 'video', provider: 'veo', jobId: 'j1', prompt: 'waves' },
  signal,
});

describe('saveGeneratedAssetToFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOrganization.mockResolvedValue({ id: 'org1', userId: 'u1', personal: false, users: [] });
    mocks.findSession.mockReset().mockResolvedValue(null);
    mocks.recordObject.mockReset().mockResolvedValue(true);
    mocks.lockCreator.mockReset().mockResolvedValue(true);
    mocks.deleteFile.mockReset().mockResolvedValue(undefined);
    mocks.rememberFileCleanup.mockReset().mockResolvedValue(undefined);
    mocks.deleteRememberedFile.mockReset().mockResolvedValue(true);
    mocks.saveGeneratedAsset.mockImplementation(
      async (_params: SaveGeneratedAssetParams, deps: SaveGeneratedAssetDeps) => {
        await deps.storage.upload('generated-video/k.mp4', Buffer.from('v'), {});
        return { saved: false, reason: 'error' };
      }
    );
  });

  it('forwards the step signal to the Files upload, defaulting the content type to the asset one', async () => {
    const controller = new AbortController();

    await saveGeneratedAssetToFiles(params(controller.signal), logger);

    expect(mocks.upload).toHaveBeenCalledWith(
      Buffer.from('v'),
      'generated-video/k.mp4',
      { ContentType: 'video/mp4' },
      controller.signal
    );
  });

  it('wires the scoped-settings store so per-scope admission overrides apply', async () => {
    await saveGeneratedAssetToFiles(params(), logger);

    const deps: SaveGeneratedAssetDeps = mocks.saveGeneratedAsset.mock.calls[0][1];
    expect(deps.db.scopedSettings).toBe(mocks.scopedSettingsRepository);
    expect(deps.logger).toBe(logger);
  });
  it('takes generated ownership from the creator-owned bound notebook and records an immutable object origin', async () => {
    mocks.findSession.mockResolvedValue({ id: 's1', retentionOrganizationId: 'org1' });
    await saveGeneratedAssetToFiles({ ...params(), sessionId: 's1', generatedOutputKey: 'output.png' }, logger);
    expect(mocks.findSession).toHaveBeenCalledWith('s1', 'u1');
    expect(mocks.recordObject).toHaveBeenCalledWith({
      key: 'output.png',
      organizationId: 'org1',
      userId: 'u1',
      sessionId: 's1',
    });
    expect(mocks.saveGeneratedAsset.mock.calls[0][1].retentionOrganizationId).toBe('org1');
    expect(mocks.saveGeneratedAsset.mock.calls[0][1]).not.toHaveProperty('ownerOrganizationId');
  });
  it('keeps unbound or foreign-notebook generations personal', async () => {
    mocks.findSession.mockResolvedValue(null);
    await saveGeneratedAssetToFiles({ ...params(), sessionId: 'foreign', generatedOutputKey: 'output.png' }, logger);
    expect(mocks.recordObject).not.toHaveBeenCalled();
    expect(mocks.saveGeneratedAsset.mock.calls[0][1].retentionOrganizationId).toBeUndefined();
  });
  it('does not bind media for a former member', async () => {
    mocks.findSession.mockResolvedValue({ id: 's1', retentionOrganizationId: 'org1' });
    mocks.findOrganization.mockResolvedValue({ id: 'org1', userId: 'someone-else', personal: false, users: [] });
    await saveGeneratedAssetToFiles({ ...params(), sessionId: 's1', generatedOutputKey: 'output.png' }, logger);
    expect(mocks.recordObject).not.toHaveBeenCalled();
    expect(mocks.saveGeneratedAsset.mock.calls[0][1].retentionOrganizationId).toBeUndefined();
  });
  it('keeps anonymized ownership but skips optional Files saving when the creator is erased', async () => {
    mocks.findSession.mockResolvedValue({ id: 's1', retentionOrganizationId: 'org1' });
    mocks.recordObject.mockResolvedValue(false);
    await expect(
      saveGeneratedAssetToFiles({ ...params(), sessionId: 's1', generatedOutputKey: 'output.png' }, logger)
    ).resolves.toEqual({ saved: false, reason: 'error' });
    expect(mocks.recordObject).toHaveBeenCalled();
    expect(mocks.saveGeneratedAsset).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'compensates only its own Files upload after a late creator refusal (throw=%s)',
    async rethrow => {
      mocks.lockCreator.mockResolvedValue(false);
      mocks.saveGeneratedAsset.mockImplementation(
        async (_params: SaveGeneratedAssetParams, deps: SaveGeneratedAssetDeps) => {
          await deps.storage.upload('generated-video/12345678-1234-1234-1234-123456789abc.mp4', Buffer.from('v'), {});
          try {
            await deps.db.fabFiles.create({} as Parameters<SaveGeneratedAssetDeps['db']['fabFiles']['create']>[0]);
            throw new Error('Expected the creator fence to refuse the write');
          } catch (cause) {
            if (rethrow) throw cause;
            return { saved: false, reason: 'error', cause };
          }
        }
      );
      const pending = saveGeneratedAssetToFiles(params(), logger);
      if (rethrow) await expect(pending).rejects.toThrow('creator is no longer active');
      else expect(await pending).toMatchObject({ saved: false, reason: 'error' });
      expect(mocks.createFile).not.toHaveBeenCalled();
      expect(mocks.rememberFileCleanup.mock.calls).toEqual([
        ['generated-video/12345678-1234-1234-1234-123456789abc.mp4'],
      ]);
      expect(mocks.deleteRememberedFile.mock.calls).toEqual([
        ['generated-video/12345678-1234-1234-1234-123456789abc.mp4'],
      ]);
      expect(mocks.deleteFile).not.toHaveBeenCalled();
    }
  );
  it('keeps the primary save result when receipt persistence fails after removing its exact upload', async () => {
    const path = 'generated-video/12345678-1234-1234-1234-123456789abc.mp4';
    mocks.lockCreator.mockResolvedValue(false);
    mocks.rememberFileCleanup.mockRejectedValueOnce(new Error('receipt database unavailable'));
    mocks.saveGeneratedAsset.mockImplementation(
      async (_params: SaveGeneratedAssetParams, deps: SaveGeneratedAssetDeps) => {
        await deps.storage.upload(path, Buffer.from('v'), {});
        try {
          await deps.db.fabFiles.create({} as Parameters<SaveGeneratedAssetDeps['db']['fabFiles']['create']>[0]);
        } catch (cause) {
          return { saved: false, reason: 'error', cause };
        }
        throw new Error('Expected creator refusal');
      }
    );
    await expect(saveGeneratedAssetToFiles(params(), logger)).resolves.toMatchObject({
      saved: false,
      reason: 'error',
      cause: { message: 'The generated asset creator is no longer active' },
    });
    expect(logger.error).toHaveBeenCalledWith('Could not complete generated Files upload cleanup', {
      path,
      cleanupError: expect.objectContaining({ message: 'receipt database unavailable' }),
    });
    expect(mocks.deleteFile.mock.calls).toEqual([[path]]);
    expect(mocks.deleteRememberedFile).not.toHaveBeenCalled();
    expect(mocks.createFile).not.toHaveBeenCalled();
  });
});
