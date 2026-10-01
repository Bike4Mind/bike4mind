import { z } from 'zod';
import { ChatQuestPollResultSchema } from './chat';

/**
 * Response shape for the public video endpoint (`generateVideo`,
 * api-contract/contracts/videoGeneration.contract.ts). The request schema lives in
 * `../schemas/sora` next to the service-side ones it extends.
 *
 * Mirrors `ImageQuestSchema` (imageApi.ts): the ACK body IS the quest document,
 * returned before the queued render has run. A render that fails afterwards polls
 * back as `type: 'error'` with the reason in `reply` - hence the chat poll
 * vocabulary for `type` / `errorCode`.
 */
export const VideoQuestSchema = ChatQuestPollResultSchema.extend({
  sessionId: z.string(),
  // Storage paths of the rendered videos; empty until the render lands.
  videos: z.array(z.string()).optional(),
});
export type VideoQuest = z.infer<typeof VideoQuestSchema>;

export const GenerateVideoResponseSchema = z.object({
  quest: VideoQuestSchema,
  // Only the id is modelled: the body carries the full session document, which is not
  // part of this endpoint's contract.
  session: z.object({ id: z.string() }),
});
export type GenerateVideoResponse = z.infer<typeof GenerateVideoResponseSchema>;
