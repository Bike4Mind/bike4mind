import type { AuthOrigin } from '@bike4mind/common';
import { questRepository } from '@bike4mind/database';
import type { VideoToolConfig } from '@bike4mind/services/llm/tools';

export const VOICE_VIDEO_DELIVERY_NOTE =
  'A call cannot play video. The finished clip appears on screen in this session chat once it is ready, so tell the user in one short sentence that it is being made and will show up in the chat. Do not read out the job id or any link.';

type VoiceVideoSlots = {
  claim: (questId: string) => Promise<boolean>;
  release: (questId: string) => Promise<void>;
};

const defaultSlots: VoiceVideoSlots = {
  claim: questId => questRepository.claimVoiceVideoStart(questId),
  release: questId => questRepository.releaseAgentGenerationSlot(questId, 'video'),
};

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
 * A claim on the turn's quest is taken before each job starts, so a turn stopped mid-call never starts a second job
 * on retry (see findDuplicateTurn in the voice completions route). A throw from createJob keeps the claim, as the
 * job may already exist.
 */
export const getVoiceVideoToolConfigResolver = (
  caller: VoiceVideoCaller,
  buildConfig: (userId: string) => Promise<VideoToolConfig | null>,
  slots: VoiceVideoSlots = defaultSlots
): (() => Promise<VideoToolConfig | null>) | undefined => {
  if (caller.apiKeyId || caller.authOrigin === 'apiKey') return undefined;
  return async () => {
    const config = await buildConfig(caller.userId);
    if (!config) return null;
    return {
      ...config,
      deliveryNote: VOICE_VIDEO_DELIVERY_NOTE,
      createJob: async input => {
        const { questId } = input;
        if (!questId || !(await slots.claim(questId))) {
          return {
            ok: false,
            status: 403,
            code: 'turn_cancelled',
            message: 'This voice turn was cancelled; do not retry.',
          };
        }
        const result = await config.createJob(input);
        if (!result.ok || !result.created) await slots.release(questId).catch(() => {});
        return result;
      },
    };
  };
};
