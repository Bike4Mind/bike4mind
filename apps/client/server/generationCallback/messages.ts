import { z } from 'zod';

/**
 * One generationCallbackQueue message: the quest id plus the event id it was claimed under, so a
 * message from a superseded arm is dropped. Everything else is still re-read per attempt - the
 * handler re-reads the callback, the quest and the signing secret on every attempt, so a retry
 * sends the quest as it is now and signs with the key's current secret, and the message never
 * carries a secret or a large body.
 */
export const GenerationCallbackMessageSchema = z.object({
  questId: z.string(),
  eventId: z.string(),
});
export type GenerationCallbackMessage = z.infer<typeof GenerationCallbackMessageSchema>;
