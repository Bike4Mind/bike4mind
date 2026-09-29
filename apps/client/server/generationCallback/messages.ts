import { z } from 'zod';

/**
 * One generationCallbackQueue message. Deliberately just the id: the handler re-reads the
 * callback (including its per-arm event id), the quest and the signing secret on every attempt,
 * so a retry sends the quest as it is now and signs with the key's current secret, and the
 * message never carries a secret or a large body.
 */
export const GenerationCallbackMessageSchema = z.object({
  questId: z.string(),
});
export type GenerationCallbackMessage = z.infer<typeof GenerationCallbackMessageSchema>;
