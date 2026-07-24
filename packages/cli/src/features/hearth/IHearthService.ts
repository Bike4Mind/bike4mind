import type { ChannelListResponse, PostEventRequest, PostEventResponse, CatchupResponse } from './types.js';

/**
 * Domain-specific service contract for Hearth operations.
 *
 * Separate from ICliFeatureModule - this is the Hearth-specific
 * abstraction that tool adapters depend on.
 */
export interface IHearthService {
  /** List all channels visible to the current actor (with IDs and names) */
  listChannels(): Promise<ChannelListResponse>;

  /** Append an event to a channel; the server assigns id/seq/actorId */
  postEvent(request: PostEventRequest): Promise<PostEventResponse>;

  /**
   * Fetch every event after this actor's cursor in a channel, ordered and
   * gap-free. advance=true (default) moves the cursor past returned events;
   * advance=false peeks without consuming.
   */
  catchup(channelId: string, options?: { advance?: boolean; limit?: number }): Promise<CatchupResponse>;
}
