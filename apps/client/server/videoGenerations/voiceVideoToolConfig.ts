import type { AuthOrigin } from '@bike4mind/common';
import type { VideoToolConfig } from '@bike4mind/services/llm/tools';

export const VOICE_VIDEO_DELIVERY_NOTE =
  'A call cannot play video. The finished clip appears on screen in this session chat once it is ready, so tell the user in one short sentence that it is being made and will show up in the chat. Do not read out the job id or any link.';

type VoiceVideoCaller = {
  userId: string;
  authOrigin?: AuthOrigin;
  apiKeyId?: string;
};

/**
 * Only calls placed from a signed-in session are offered the tool. A key-minted call would start billed video jobs
 * past the video-generations contract's scope check and rate limit, and has no chat for the clip to appear in.
 * The job is not stamped with a delivery target: the existing job card on the turn's quest receives the websocket
 * update on its own, which is what the delivery note promises.
 */
export const getVoiceVideoToolConfigResolver = (
  caller: VoiceVideoCaller,
  buildConfig: (userId: string) => Promise<VideoToolConfig | null>
): (() => Promise<VideoToolConfig | null>) | undefined => {
  if (caller.apiKeyId || caller.authOrigin === 'apiKey') return undefined;
  return async () => {
    const config = await buildConfig(caller.userId);
    return config && { ...config, deliveryNote: VOICE_VIDEO_DELIVERY_NOTE };
  };
};
