import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HearthService } from '../HearthService.js';
import type { ApiClient } from '../../../auth/ApiClient.js';

function createMockApiClient() {
  return {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn(),
    delete: vi.fn(),
  };
}

describe('HearthService', () => {
  let apiClient: ReturnType<typeof createMockApiClient>;
  let service: HearthService;

  beforeEach(() => {
    apiClient = createMockApiClient();
    service = new HearthService(apiClient as unknown as ApiClient);
  });

  it('listChannels GETs /api/hearth/channels', async () => {
    await service.listChannels();
    expect(apiClient.get).toHaveBeenCalledWith('/api/hearth/channels');
  });

  it('postEvent POSTs the request body to /api/hearth/events', async () => {
    const request = {
      channelId: 'ch-1',
      kind: 'message' as const,
      human: { text: 'hi', format: 'md' as const },
      refs: {},
    };
    await service.postEvent(request);
    expect(apiClient.post).toHaveBeenCalledWith('/api/hearth/events', request);
  });

  it('catchup POSTs channelId with options to /api/hearth/catchup', async () => {
    await service.catchup('ch-1', { advance: false, limit: 25 });
    expect(apiClient.post).toHaveBeenCalledWith('/api/hearth/catchup', {
      channelId: 'ch-1',
      advance: false,
      limit: 25,
    });
  });

  it('catchup defaults to no option overrides (server-side advance default)', async () => {
    await service.catchup('ch-1');
    expect(apiClient.post).toHaveBeenCalledWith('/api/hearth/catchup', { channelId: 'ch-1' });
  });

  it('propagates transport errors unchanged', async () => {
    apiClient.get.mockRejectedValueOnce(new Error('401'));
    await expect(service.listChannels()).rejects.toThrow('401');
  });
});
