import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture S3 uploads and DB reads. publicSafeSettingKeys/buildPublicSettingsProjection
// from @bike4mind/common are used for real (pure functions = the security boundary).
// vi.hoisted so the mocks exist before the hoisted vi.mock factories run.
const { uploadMock, leanMock } = vi.hoisted(() => ({
  uploadMock: vi.fn().mockResolvedValue('app-config/public-settings.json'),
  leanMock: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: { appFilesBucket: { name: 'test-bucket' } } }));
vi.mock('@bike4mind/fab-pipeline', () => ({
  // class so `new S3Storage(...)` is constructable; every instance shares the upload spy.
  S3Storage: class {
    upload = uploadMock;
  },
}));
vi.mock('@bike4mind/database/infra', () => ({
  AdminSettings: { find: vi.fn(() => ({ lean: leanMock })) },
}));

// Imported dynamically (after the vi.mock factories above are hoisted) so Vite's static
// import-analysis doesn't eagerly resolve @bike4mind/fab-pipeline - mirrors storage/index.test.ts.
const loadModule = () => import('./publicSettingsArtifact');

describe('publicSettingsArtifact', () => {
  beforeEach(() => {
    uploadMock.mockClear();
    leanMock.mockReset();
  });

  describe('materializePublicSettingsArtifact', () => {
    it('uploads to the correct key with JSON + stale-while-revalidate cache headers', async () => {
      const { materializePublicSettingsArtifact, PUBLIC_SETTINGS_KEY } = await loadModule();
      leanMock.mockResolvedValue([{ settingName: 'enforceMFA', settingValue: 'true' }]);
      await materializePublicSettingsArtifact();

      expect(uploadMock).toHaveBeenCalledTimes(1);
      const [, key, opts] = uploadMock.mock.calls[0];
      expect(key).toBe(PUBLIC_SETTINGS_KEY);
      expect(opts).toMatchObject({
        ContentType: 'application/json',
        CacheControl: expect.stringContaining('stale-while-revalidate'),
      });
    });

    it('emits a versioned envelope containing only publicSafe keys', async () => {
      const { materializePublicSettingsArtifact } = await loadModule();
      leanMock.mockResolvedValue([
        { settingName: 'enforceMFA', settingValue: 'true' },
        { settingName: 'DefaultAPIModel', settingValue: 'gpt-5' },
        // even if a non-publicSafe key sneaks into the query result, it must be dropped:
        { settingName: 'openaiDemoKey', settingValue: 'sk-SHOULD-NEVER-LEAK' },
      ]);
      await materializePublicSettingsArtifact();

      const body = uploadMock.mock.calls[0][0] as string;
      const artifact = JSON.parse(body);
      expect(artifact).toMatchObject({ version: expect.any(Number), updatedAt: expect.any(String) });
      expect(artifact.settings.map((s: { settingName: string }) => s.settingName).sort()).toEqual([
        'DefaultAPIModel',
        'enforceMFA',
      ]);
      expect(body).not.toContain('sk-SHOULD-NEVER-LEAK');
    });

    it('never leaks Mongo/soft-delete metadata into the artifact', async () => {
      const { materializePublicSettingsArtifact } = await loadModule();
      leanMock.mockResolvedValue([
        {
          settingName: 'enforceMFA',
          settingValue: 'true',
          _id: 'ID123',
          __v: 7,
          createdAt: 'c',
          updatedAt: 'u',
          deletedAt: null,
        },
      ]);
      await materializePublicSettingsArtifact();

      const body = uploadMock.mock.calls[0][0] as string;
      const artifact = JSON.parse(body);
      // Strong guarantee: each setting has exactly the two fields, nothing else.
      for (const setting of artifact.settings) {
        expect(Object.keys(setting).sort()).toEqual(['settingName', 'settingValue']);
      }
      // Canary check scoped to the settings (the envelope itself legitimately has updatedAt).
      const settingsJson = JSON.stringify(artifact.settings);
      for (const meta of ['_id', '__v', 'ID123', 'deletedAt']) {
        expect(settingsJson).not.toContain(meta);
      }
    });
  });

  describe('ensurePublicSettingsArtifactOncePerInstance', () => {
    it('awaits, retries after a transient failure, then becomes a no-op after success', async () => {
      const { ensurePublicSettingsArtifactOncePerInstance } = await loadModule();
      const logger = { error: vi.fn(), info: vi.fn() };

      // 1st attempt fails - must NOT permanently disable self-heal, and must not throw.
      leanMock.mockRejectedValueOnce(new Error('transient S3/DB error'));
      await ensurePublicSettingsArtifactOncePerInstance(logger);
      expect(logger.error).toHaveBeenCalled();
      expect(uploadMock).not.toHaveBeenCalled();

      // 2nd attempt succeeds (retry allowed because the prior attempt failed).
      leanMock.mockResolvedValueOnce([{ settingName: 'enforceMFA', settingValue: 'true' }]);
      await ensurePublicSettingsArtifactOncePerInstance(logger);
      expect(uploadMock).toHaveBeenCalledTimes(1);

      // 3rd call is a no-op now that one attempt has succeeded.
      await ensurePublicSettingsArtifactOncePerInstance(logger);
      expect(uploadMock).toHaveBeenCalledTimes(1);
    });
  });
});
