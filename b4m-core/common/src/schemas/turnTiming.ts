import { z } from 'zod';
import { TURN_RETRY_REASONS, type ITurnRetry, type ITurnTiming } from '../types';

const turnRetryShape = {
  reason: z.enum(TURN_RETRY_REASONS),
  status: z.number().optional(),
  retryAfterMs: z.number().optional(),
  requestId: z.string().optional(),
  delayMs: z.number(),
  model: z.string(),
};

const turnTimingShape = {
  queueMs: z.number(),
  contextBuildMs: z.number().optional(),
  semaphoreWaitMs: z.number(),
  totalMs: z.number().optional(),
  fallbackHops: z.number(),
};

/** Wire shape of ITurnTiming for the live chat frame; hydrates `at` into a Date server-side. */
export const TurnTimingSchema = z.object({
  ...turnTimingShape,
  retries: z.array(z.object({ ...turnRetryShape, at: z.coerce.date() })),
});

/**
 * The same record for the public quest poll. `at` is an ISO string on the wire (a Date only
 * before JSON serialization). Not z.coerce.date() here: like the other public response schemas
 * (schemas/chat.ts, schemas/session.ts), it would document the field as nullable in OpenAPI.
 */
export const TurnTimingPollSchema = z.object({
  ...turnTimingShape,
  retries: z.array(z.object({ ...turnRetryShape, at: z.union([z.string().datetime(), z.date()]) })),
});

// Fails to compile when ITurnTiming and the schema drift apart, in either direction.
// The Mongoose copy in QuestModel.ts is the third and is kept in sync by hand.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const turnTimingSchemaMatchesType: Exact<z.infer<typeof TurnTimingSchema>, ITurnTiming> = true;
void turnTimingSchemaMatchesType;

// The poll variant differs only in `at`, a Date before JSON and an ISO string after.
type PollTurnTiming = Omit<ITurnTiming, 'retries'> & {
  retries: Array<Omit<ITurnRetry, 'at'> & { at: string | Date }>;
};
const turnTimingPollSchemaMatchesType: Exact<z.infer<typeof TurnTimingPollSchema>, PollTurnTiming> = true;
void turnTimingPollSchemaMatchesType;
