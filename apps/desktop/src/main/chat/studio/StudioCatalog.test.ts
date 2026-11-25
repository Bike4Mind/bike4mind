import { describe, expect, it, vi } from 'vitest';
import { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { AxiosError, type AxiosAdapter, type AxiosResponse } from 'axios';
import type { ModelCatalog } from '../ModelCatalog';
import { readStudioCatalog } from './StudioCatalog';

function catalogWith(
  imageModels: { status: number; data: unknown } = { status: 200, data: { models: [{ id: 'gpt-image-2' }] } }
) {
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
        ({ status, data } = imageModels);
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
  it('lists the public image models, reading only GET routes and no Studio-only route', async () => {
    const { run, transport } = catalogWith();
    expect((await run()).images.map(image => image.id)).toEqual(['gpt-image-2']);
    expect(transport.mock.calls.every(([config]) => config.method === 'get')).toBe(true);
    expect(transport.mock.calls.some(([config]) => config.url?.startsWith('/api/studio/'))).toBe(false);
  });
  it('drops a listed model this build has no capabilities for', async () => {
    const { run } = catalogWith({ status: 200, data: { models: [{ id: 'gpt-image-2' }, { id: 'not-a-model' }] } });
    expect((await run()).images.map(image => image.id)).toEqual(['gpt-image-2']);
  });
  it.each([401, 403, 500])('fails loudly when the image model list answers HTTP %i', async status => {
    await expect(catalogWith({ status, data: { error: 'Something else' } }).run()).rejects.toThrow();
  });
});
