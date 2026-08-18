import type { ApiClient } from '../../auth/ApiClient.js';
import type { IHearthService } from './IHearthService.js';
import type {
  ChannelListResponse,
  HearthSession,
  PostEventRequest,
  PostEventResponse,
  CatchupResponse,
} from './types.js';

/**
 * HTTP implementation of IHearthService using the shared ApiClient.
 *
 * Each method maps to one /api/hearth/* endpoint. Pure transport - no business
 * logic - with one exception: it stamps the per-session identity onto every
 * write and cursor read, because forgetting it on a single call site silently
 * reintroduces the shared-cursor bug (the request still succeeds, it just
 * resolves to the account-wide actor). `sessionProvider` is a callback rather
 * than a value so a session switch or hot-reload cannot leave a stale id here.
 */
export class HearthService implements IHearthService {
  constructor(
    private readonly apiClient: ApiClient,
    private readonly sessionProvider?: () => HearthSession | undefined
  ) {}

  private session(): HearthSession | undefined {
    return this.sessionProvider?.();
  }

  async listChannels(): Promise<ChannelListResponse> {
    return this.apiClient.get<ChannelListResponse>('/api/hearth/channels');
  }

  async postEvent(request: PostEventRequest): Promise<PostEventResponse> {
    return this.apiClient.post<PostEventResponse>('/api/hearth/events', {
      ...request,
      session: request.session ?? this.session(),
    });
  }

  async catchup(channelId: string, options: { advance?: boolean; limit?: number } = {}): Promise<CatchupResponse> {
    return this.apiClient.post<CatchupResponse>('/api/hearth/catchup', {
      channelId,
      ...options,
      session: this.session(),
    });
  }
}
