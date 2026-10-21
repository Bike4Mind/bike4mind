import { z } from 'zod';
import { TURN_RETRY_REASONS, type ITurnTiming } from '../types';

/** Wire shape of ITurnTiming, shared by the live chat frame and the public quest poll. */
export const TurnTimingSchema = z.object({
  queueMs: z.number(),
  contextBuildMs: z.number().optional(),
  semaphoreWaitMs: z.number(),
  totalMs: z.number().optional(),
  retries: z.array(
    z.object({
      reason: z.enum(TURN_RETRY_REASONS),
      status: z.number().optional(),
      retryAfterMs: z.number().optional(),
      requestId: z.string().optional(),
      delayMs: z.number(),
      model: z.string(),
      at: z.coerce.date(),
    })
  ),
  fallbackHops: z.number(),
});

// Fails to compile when ITurnTiming and the schema drift apart, in either direction.
// The Mongoose copy in QuestModel.ts is the third and is kept in sync by hand.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const turnTimingSchemaMatchesType: Exact<z.infer<typeof TurnTimingSchema>, ITurnTiming> = true;
void turnTimingSchemaMatchesType;
