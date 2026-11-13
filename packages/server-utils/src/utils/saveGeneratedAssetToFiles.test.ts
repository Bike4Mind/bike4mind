import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaveGeneratedAssetDeps, SaveGeneratedAssetParams } from '@bike4mind/services';

const mocks = vi.hoisted(() => ({
  saveGeneratedAsset: vi.fn(),
  upload: vi.fn(),
  getSignedUrl: vi.fn(),
  scopedSettingsRepository: { name: 'scopedSettings' },
  findSession: vi.fn(),
  recordObject: vi.fn(),
}));

vi.mock('@bike4mind/services', () => ({ saveGeneratedAsset: mocks.saveGeneratedAsset }));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: {},
  adminSettingsRepository: {},
  dataLakeRepository: {},
  fabFileRepository: {},
  scopedSettingsRepository: mocks.scopedSettingsRepository,
  sessionRepository: { findByIdAndUserId: mocks.findSession },
  OrganizationGeneratedObject: { updateOne: mocks.recordObject },
  User: {},
}));
vi.mock('./storage/index', () => ({
  getFilesStorage: () => ({ upload: mocks.upload, getSignedUrl: mocks.getSignedUrl }),
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
    expect(mocks.recordObject).toHaveBeenCalledWith(
      { key: 'output.png' },
      {
        $setOnInsert: {
          key: 'output.png',
          organizationId: 'org1',
          userId: 'u1',
          sessionId: 's1',
          createdAt: expect.any(Date),
        },
      },
      { upsert: true }
    );
    expect(mocks.saveGeneratedAsset.mock.calls[0][1].ownerOrganizationId).toBe('org1');
  });
  it('keeps unbound or foreign-notebook generations personal', async () => {
    mocks.findSession.mockResolvedValue(null);
    await saveGeneratedAssetToFiles({ ...params(), sessionId: 'foreign', generatedOutputKey: 'output.png' }, logger);
    expect(mocks.recordObject).not.toHaveBeenCalled();
    expect(mocks.saveGeneratedAsset.mock.calls[0][1].ownerOrganizationId).toBeUndefined();
  });
});
