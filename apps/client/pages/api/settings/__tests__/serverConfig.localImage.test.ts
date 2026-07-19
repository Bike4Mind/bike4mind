// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// serverConfig.ts builds its API handler at module load, so stub the middleware
// and the heavy DB/service deps; isLocalImageBackendAvailable only reads env.
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ get: (fn: unknown) => fn }) }));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/utils/config', () => ({ Config: {} }));
vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@bike4mind/services', () => ({ apiKeyService: {} }));
vi.mock('@bike4mind/database', () => ({ apiKeyRepository: {}, adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));

import { isLocalImageBackendAvailable } from '../serverConfig';

describe('isLocalImageBackendAvailable (image_generation self-host availability rule)', () => {
  const savedSelfHost = process.env.B4M_SELF_HOST;
  const savedUrl = process.env.IMAGE_GEN_BASE_URL;

  beforeEach(() => {
    delete process.env.B4M_SELF_HOST;
    delete process.env.IMAGE_GEN_BASE_URL;
  });

  afterEach(() => {
    if (savedSelfHost === undefined) delete process.env.B4M_SELF_HOST;
    else process.env.B4M_SELF_HOST = savedSelfHost;
    if (savedUrl === undefined) delete process.env.IMAGE_GEN_BASE_URL;
    else process.env.IMAGE_GEN_BASE_URL = savedUrl;
  });

  it('is true when self-host and IMAGE_GEN_BASE_URL is set', () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.IMAGE_GEN_BASE_URL = 'http://imagegen:7860';
    expect(isLocalImageBackendAvailable()).toBe(true);
  });

  it('is false when IMAGE_GEN_BASE_URL is set but B4M_SELF_HOST is not (hosted deploy)', () => {
    process.env.IMAGE_GEN_BASE_URL = 'http://imagegen:7860';
    expect(isLocalImageBackendAvailable()).toBe(false);
  });

  it('is false under self-host when IMAGE_GEN_BASE_URL is unset or blank', () => {
    process.env.B4M_SELF_HOST = 'true';
    expect(isLocalImageBackendAvailable()).toBe(false);
    process.env.IMAGE_GEN_BASE_URL = '   ';
    expect(isLocalImageBackendAvailable()).toBe(false);
  });
});
