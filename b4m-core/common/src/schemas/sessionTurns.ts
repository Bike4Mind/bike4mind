import { z } from 'zod';
import { ModelIdSchema } from './modelId';
import { CompletionSseErrorEventSchema } from './cliCompletions';
import { MAX_THINKING_BUDGET_TOKENS } from '../constants/llmLimits';
// Specific file, not the `../types` barrel - see the note in cliCompletions.ts.
import { QUEST_OUTCOME_ERROR_CODES } from '../types/entities/SessionTypes';

/**
 * Wire shapes for POST /api/v1/turns (sessionTurns.contract.ts): add a turn to an existing
 * session and stream it back as SSE. Served by the ChatCompletion service
 * (apps/client/server/chatCompletion/external/turnsRoute.ts), which validates with these exact
 * objects. Deliberately narrower than the web composer's LLMApiRequestBody (llm.ts): the fields a
 * caller needs to pick a model and attach files, nothing else yet. Wire fields are snake_case
 * (api-contract/CONVENTIONS.md section 2); the route maps them onto the camelCase invoke params.
 */

/** History window when the caller sends none; matches the POST /api/chat default. */
export const DEFAULT_SESSION_TURN_HISTORY_COUNT = 10;

const MAX_TURN_FILE_IDS = 100;

const FileIdListSchema = z.array(z.string().min(1)).max(MAX_TURN_FILE_IDS);

export const SessionTurnRequestSchema = z.object({
  session_id: z.string().min(1).describe('The session (notebook) to add the turn to. It must already exist.'),
  message: z.string().min(1).describe('The user message for this turn.'),
  model: ModelIdSchema.describe('Model id, as listed by `GET /api/v1/models`.'),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Output ceiling. Omit it to let the server size it for the model.'),
  thinking: z
    .object({
      enabled: z.boolean(),
      budget_tokens: z.number().int().positive().max(MAX_THINKING_BUDGET_TOKENS).optional(),
    })
    .optional(),
  message_file_ids: FileIdListSchema.optional().describe('Files attached to this message.'),
  fab_file_ids: FileIdListSchema.optional().describe('Workbench files to put in context for this turn.'),
  history_count: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(`Earlier turns of the session to send as context. Defaults to ${DEFAULT_SESSION_TURN_HISTORY_COUNT}.`),
  prompt_mode: z
    .enum(['raw', 'grounded', 'surface'])
    .optional()
    .describe(
      'How much of the system stack to place in front of the model. Unset keeps the full stack the web app uses.'
    ),
  organization_id: z
    .string()
    .nullable()
    .optional()
    .describe('Organization to bill. `null` bills personal credits; omitted uses the caller default.'),
  client_submitted_at: z
    .number()
    .optional()
    .describe('Epoch ms when the client submitted the message, for the turn timing log.'),
});
export type SessionTurnRequest = z.infer<typeof SessionTurnRequestSchema>;

/**
 * Event fields are snake_case (CONVENTIONS.md section 2), except in `meta` and `error`: those are the
 * completions stream's shared events (buildMetaEvent, formatSSEError) and keep its `requestId`.
 */
const SessionTurnMetaEventSchema = z.object({
  type: z.literal('meta'),
  requestId: z.string(),
});

/** Sent once the turn's quest exists, so the caller can map it to the session's message list. */
const SessionTurnStartedEventSchema = z.object({
  type: z.literal('turn'),
  quest_id: z.string(),
  session_id: z.string(),
});

/**
 * `slot` is an index into the quest's reply slots (`replies[]`; thinking models put the thinking
 * text in an earlier slot than the answer). A `delta` appends `text` to that slot.
 */
const SessionTurnDeltaEventSchema = z.object({
  type: z.literal('delta'),
  quest_id: z.string(),
  slot: z.number().int().nonnegative(),
  text: z.string(),
});

/** The slot was reset or rewritten (a retry, a rapid-reply handoff): `text` replaces it whole. */
const SessionTurnReplaceEventSchema = z.object({
  type: z.literal('replace'),
  quest_id: z.string(),
  slot: z.number().int().nonnegative(),
  text: z.string(),
});

export const SESSION_TURN_SETTLED_STATUSES = ['done', 'stopped'] as const;

/**
 * The turn reached a terminal status. Sent once, after the last delta and before `[DONE]`. `failed`
 * covers refusals that carry no `error_code` (a model the plan or organization does not allow), which
 * settle as `done` with an explanation in the slots.
 */
const SessionTurnSettledEventSchema = z.object({
  type: z.literal('settled'),
  quest_id: z.string(),
  status: z.enum(SESSION_TURN_SETTLED_STATUSES),
  failed: z.boolean(),
  credits_used: z.number().optional(),
  error_code: z.enum(QUEST_OUTCOME_ERROR_CODES).optional(),
});

export const SessionTurnStreamEventSchema = z.union([
  SessionTurnMetaEventSchema,
  SessionTurnStartedEventSchema,
  SessionTurnDeltaEventSchema,
  SessionTurnReplaceEventSchema,
  SessionTurnSettledEventSchema,
  CompletionSseErrorEventSchema,
]);
export type SessionTurnStreamEvent = z.infer<typeof SessionTurnStreamEventSchema>;
export type SessionTurnSettledEvent = z.infer<typeof SessionTurnSettledEventSchema>;
/** The reply-slot events, produced by the frame differ in the turns route. */
export type SessionTurnSlotEvent =
  z.infer<typeof SessionTurnDeltaEventSchema> | z.infer<typeof SessionTurnReplaceEventSchema>;

/** Same `data:` framing as serializeSSEEvent (utils/sseEvents.ts), for the turn event union. */
export function serializeSessionTurnEvent(event: SessionTurnStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
