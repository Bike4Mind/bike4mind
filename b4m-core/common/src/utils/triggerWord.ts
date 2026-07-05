/**
 * Trigger-word validation, shared between client form and server agent
 * endpoints so the validation rules can't drift.
 *
 * Rules (GitHub-handle style):
 * - Must start with `@`
 * - Followed by 1-31 chars of alphanumeric, hyphens, or underscores
 * - May not start or end with a hyphen
 * - Total length 2-32 chars (including the `@`)
 *
 * Why these rules: the chat-side mention parser (`detectAgentMentions`)
 * matches `[a-zA-Z0-9_](?:[a-zA-Z0-9_-]*[a-zA-Z0-9_])?`. Any trigger word
 * the agent form lets through but the parser can't read is a silent
 * routing failure with no user feedback. Validating at save time closes
 * that gap.
 */
import { z } from 'zod';

export const TRIGGER_WORD_BODY = /^[a-zA-Z0-9_](?:[a-zA-Z0-9_-]{0,30}[a-zA-Z0-9_])?$/;

export const TRIGGER_WORD_ERROR_MESSAGE =
  'Trigger words must start with @ followed by 1–31 letters, numbers, underscores, or hyphens, and may not start or end with a hyphen.';

/**
 * Validate a single trigger word (the full `@handle` form).
 */
export const triggerWordSchema = z
  .string()
  .min(2, TRIGGER_WORD_ERROR_MESSAGE)
  .max(32, TRIGGER_WORD_ERROR_MESSAGE)
  .refine(value => value.startsWith('@') && TRIGGER_WORD_BODY.test(value.slice(1)), TRIGGER_WORD_ERROR_MESSAGE);

/**
 * Validate the full `triggerWords` array on an agent.
 *
 * Dedupes case-insensitively after validation: the chat-side parser lowercases
 * mentions before matching, so `['@Bob', '@bob']` would route identically. The
 * form already blocks dupes interactively via `isTagExistInRecords`; this keeps
 * direct API callers symmetric and prevents redundant entries from landing in
 * Mongo.
 */
export const triggerWordsSchema = z
  .array(triggerWordSchema)
  .max(20, 'Up to 20 trigger words allowed.')
  .transform(words => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const word of words) {
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  });

/**
 * Pure validator for direct use in form-state hooks (no error throwing).
 * Returns the validated string on success, or an error message on failure.
 */
export function validateTriggerWord(value: string): { ok: true; value: string } | { ok: false; error: string } {
  const result = triggerWordSchema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: result.error.issues[0]?.message ?? TRIGGER_WORD_ERROR_MESSAGE };
}
