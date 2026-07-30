import type { ApiClient } from '../../auth/ApiClient.js';
import type { IHearthService } from './IHearthService.js';
import type { ChannelListResponse, PostEventRequest, PostEventResponse, CatchupResponse } from './types.js';

/**
 * HTTP implementation of IHearthService using the shared ApiClient.
 *
 * Each method maps to one /api/hearth/* endpoint (server routes ship with
 * the fanout/PWA phase; this module is gated behind config.features.hearth
 * until then). Pure transport - no business logic.
 */
export class HearthService implements IHearthService {
  constructor(private readonly apiClient: ApiClient) {}

  async listChannels(): Promise<ChannelListResponse> {
    return this.apiClient.get<ChannelListResponse>('/api/hearth/channels');
  }

  async postEvent(request: PostEventRequest): Promise<PostEventResponse> {
    return this.apiClient.post<PostEventResponse>('/api/hearth/events', request);
  }

  async catchup(channelId: string, options: { advance?: boolean; limit?: number } = {}): Promise<CatchupResponse> {
    return this.apiClient.post<CatchupResponse>('/api/hearth/catchup', {
      channelId,
      ...options,
    });
  }
}
