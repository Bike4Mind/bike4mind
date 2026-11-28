import { z } from 'zod';
import { parseGenerationInput, type GenerationSettings } from '../generation';
import { newSessionDefaultsSchema } from '../sessionDefaults';
import { chatSessionSummaryPayloadSchema, sendMessageResultPayloadSchema } from './payloads';

/*
 * Session settings and turn revision (since 1.4). The field rules are the ones a new session's
 * defaults already use (shared/sessionDefaults) and the generation rules Desktop's own settings
 * apply (parseGenerationInput), so a value refused here is refused everywhere.
 */

/** A generation set as parseGenerationInput accepts it; an empty object clears the overrides. */
const generationSettingsSchema = z.unknown().transform((raw, context): GenerationSettings => {
  const settings = parseGenerationInput(raw);
  if (settings) return settings;
  context.addIssue({ code: 'custom', message: 'Not a valid set of generation settings' });
  return z.NEVER;
});

const { model, approvalMode, reasoningEffort } = newSessionDefaultsSchema.shape;

export const sessionSettingsPatchSchema = z
  .strictObject({
    model,
    reasoningEffort,
    promptCacheTtl: newSessionDefaultsSchema.shape.promptCacheTtl.unwrap(),
    generation: generationSettingsSchema,
    approvalMode,
  })
  .partial()
  .refine(patch => Object.keys(patch).length > 0, { message: 'Name at least one setting' });
export type SessionSettingsPatch = z.output<typeof sessionSettingsPatchSchema>;

const turnResult = sendMessageResultPayloadSchema;

export const sessionSettingsMethods = {
  // Applies every field or none, and replies with the session's summary as it then stands; every
  // connection, this one included, also gets it as session/summaryChanged. Per-model settings
  // of a local model are not session settings and are not here.
  'session/configure': {
    params: z.strictObject({ sessionId: z.string().min(1).max(64), patch: sessionSettingsPatchSchema }),
    result: z.strictObject({ summary: chatSessionSummaryPayloadSchema }),
  },
} as const;

/*
 * Each answers as turn/send does. An edit or a regenerate replaces the end of the transcript, so
 * the session's event epoch changes with it: a subscriber sees the next event under a new epoch
 * and a resume from an older cursor fails with snapshotRequired, and either way the client reads
 * the session again (session/get).
 */
export const turnRevisionMethods = {
  // Carries on a reply its own budget stopped, in place.
  'turn/continue': { params: z.strictObject({ sessionId: z.string().min(1).max(64) }), result: turnResult },
  // Replaces the prompt `messageId` and everything after it with `text`, then runs it.
  'turn/edit': {
    params: z.strictObject({
      sessionId: z.string().min(1).max(64),
      messageId: z.string().min(1).max(64),
      text: z.string().min(1),
    }),
    result: turnResult,
  },
  // Runs the last prompt again in place of its reply. With `messageId`, only while that is still
  // the reply that would be replaced.
  'turn/regenerate': {
    params: z.strictObject({ sessionId: z.string().min(1).max(64), messageId: z.string().min(1).max(64).optional() }),
    result: turnResult,
  },
} as const;
