// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// serverConfig.ts builds its API handler at module load, so stub the middleware
// and the heavy DB/service deps; isLocalEmbedderAvailable only reads env.
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ get: (fn: unknown) => fn }) }));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/utils/config', () => ({ Config: {} }));
vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@bike4mind/services', () => ({ apiKeyService: {} }));
vi.mock('@bike4mind/database', () => ({ apiKeyRepository: {}, adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));

import { isLocalEmbedderAvailable } from '../serverConfig';

describe('isLocalEmbedderAvailable (search_knowledge_base self-host availability rule)', () => {
  const savedSelfHost = process.env.B4M_SELF_HOST;
  const savedUrl = process.env.OLLAMA_BASE_URL;

  beforeEach(() => {
    delete process.env.B4M_SELF_HOST;
    delete process.env.OLLAMA_BASE_URL;
  });

  afterEach(() => {
    if (savedSelfHost === undefined) delete process.env.B4M_SELF_HOST;
    else process.env.B4M_SELF_HOST = savedSelfHost;
    if (savedUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = savedUrl;
  });

  it('is true when self-host and OLLAMA_BASE_URL is set', () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    expect(isLocalEmbedderAvailable()).toBe(true);
  });

  it('is false when OLLAMA_BASE_URL is set but B4M_SELF_HOST is not (hosted deploy)', () => {
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    expect(isLocalEmbedderAvailable()).toBe(false);
  });

  it('is false under self-host when OLLAMA_BASE_URL is unset or blank', () => {
    process.env.B4M_SELF_HOST = 'true';
    expect(isLocalEmbedderAvailable()).toBe(false);
    process.env.OLLAMA_BASE_URL = '   ';
    expect(isLocalEmbedderAvailable()).toBe(false);
  });
});
