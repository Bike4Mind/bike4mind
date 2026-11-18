import { describe, expect, it, vi } from 'vitest';
import { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { AxiosError, type AxiosAdapter, type AxiosResponse } from 'axios';
import type { ModelCatalog } from '../ModelCatalog';
import { readStudioCatalog } from './StudioCatalog';

function catalogWith(probe: { status: number; data: unknown }) {
  const api = new AuthenticatedApiClient({
    baseUrl: 'https://example.test',
    tokenStore: {
      getAuthTokens: async () => null,
      setAuthTokens: async () => {},
      clearAuthTokens: async () => {},
      isAuthenticated: async () => false,
    },
    oauthClient: { refreshToken: vi.fn() },
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    reauthMessages: { refreshFailed: 'refresh', stillUnauthorized: 'unauthorized' },
  });
  const transport = vi.fn<AxiosAdapter>(async config => {
    let status = 200;
    let data: unknown;
    switch (config.url) {
      case '/api/v1/image-models':
        data = { models: [{ id: 'gpt-image-2' }] };
        break;
      case '/api/v1/music-models':
        data = { models: [] };
        break;
      case '/api/ai/audio-providers':
        data = { speech: [], soundEffects: [] };
        break;
      case '/api/ai/elevenlabs-voices':
        data = { voices: [] };
        break;
      case '/api/studio/image-jobs?limit=1':
        ({ status, data } = probe);
        break;
      default:
        throw new Error('Unexpected request');
    }
    const response: AxiosResponse<unknown> = { config, status, data, headers: {}, statusText: String(status) };
    if (status >= 400) throw new AxiosError('Refused', 'ERR_BAD_RESPONSE', config, undefined, response);
    return response;
  });
  api.getAxiosInstance().defaults.adapter = transport;
  const models = { listVideoModels: async () => [] } as unknown as ModelCatalog;
  return { run: () => readStudioCatalog(api, models), transport };
}

describe('Studio image availability', () => {
  it('hides image creation when the authenticated image route is disabled', async () => {
    const { run, transport } = catalogWith({
      status: 403,
      data: { error: 'Feature not available', code: 'FEATURE_DISABLED' },
    });
    expect((await run()).images).toEqual([]);
    expect(transport.mock.calls.every(([config]) => config.method === 'get')).toBe(true);
  });
  it('retains available images when the read-only capability probe succeeds', async () => {
    expect((await catalogWith({ status: 200, data: { data: [] } }).run()).images.map(image => image.id)).toEqual([
      'gpt-image-2',
    ]);
  });
  it.each([401, 403, 500])('does not hide an unrelated HTTP %i failure as feature availability', async status => {
    await expect(catalogWith({ status, data: { error: 'Something else' } }).run()).rejects.toThrow();
  });
});
