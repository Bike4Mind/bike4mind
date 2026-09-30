import { z } from 'zod';
import { PromptIntentSchema } from '../llm';
import { ChatQuestPollResultSchema } from './chat';

/**
 * Response shapes for the public image endpoints (`generateImage` / `editImage`,
 * api-contract/contracts/image*.contract.ts). The request schemas live in `../llm`
 * next to the service-side ones they extend.
 *
 * One quest shape serves both the ACK and the poll, because the ACK body IS the
 * quest document, returned before the queued render has run. A render that fails
 * afterwards (credit exhaustion, a provider error, a rejected reference image)
 * polls back as `type: 'error'` with the reason in `reply` - hence the chat poll
 * vocabulary for `type` / `errorCode`.
 */
export const ImageQuestSchema = ChatQuestPollResultSchema.extend({
  sessionId: z.string(),
  // Storage paths of the rendered images; empty until the render lands.
  images: z.array(z.string()).optional(),
});
export type ImageQuest = z.infer<typeof ImageQuestSchema>;

export const GenerateImageResponseSchema = z.object({
  quest: ImageQuestSchema,
  // Only the id is modelled: the body carries the full session document, which is not
  // part of this endpoint's contract.
  session: z.object({ id: z.string() }),
  originalPrompt: z.string(),
  enhancedPrompt: z.string(),
  promptWasEnhanced: z.boolean(),
  intent: PromptIntentSchema,
});
export type GenerateImageResponse = z.infer<typeof GenerateImageResponseSchema>;
