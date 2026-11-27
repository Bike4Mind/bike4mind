import { z } from 'zod';

/**
 * Wire schemas for delegated items (`/api/v1/delegations`): something the user forwarded to the assistant
 * (a link, some text, uploaded files) with one line of intent. The assistant works on it in the background,
 * and the outcome reaches the user's next brief as a handled item or a decision.
 */

export const DELEGATION_STATUSES = ['pending', 'handled', 'needs_decision', 'failed'] as const;
export const DelegationStatusSchema = z.enum(DELEGATION_STATUSES);
export type DelegationStatus = z.infer<typeof DelegationStatusSchema>;

/** Bounds shared by the route, the stored record and the worker. */
export const DELEGATION_LIMITS = {
  intent: 200,
  url: 2048,
  text: 8000,
  files: 10,
  result: 400,
} as const;

/** Strict, so a camelCase `fileIds` is a 422 rather than silently dropped. */
export const DelegationCreateRequestSchema = z
  .object({
    intent: z
      .string()
      .max(DELEGATION_LIMITS.intent)
      .regex(/^[^\r\n]*\S[^\r\n]*$/, 'intent must be one non-blank line')
      .describe('One line telling the assistant what to do with the item, e.g. "summarize for the team".'),
    url: z
      .string()
      .max(DELEGATION_LIMITS.url)
      .regex(/^https?:\/\/\S+$/i, 'url must be an http or https URL')
      .optional()
      .describe('A shared link. The assistant reads the page.'),
    text: z.string().min(1).max(DELEGATION_LIMITS.text).optional().describe('Shared plain text.'),
    file_ids: z
      .array(z.string().min(1))
      .max(DELEGATION_LIMITS.files)
      .optional()
      .describe('Files you uploaded with `POST /api/v1/files`. Each must be yours.'),
  })
  .strict();
export type DelegationCreateRequest = z.infer<typeof DelegationCreateRequestSchema>;

export const DelegationSchema = z.object({
  id: z.string().min(1),
  status: DelegationStatusSchema.describe(
    '`pending` while the assistant works on it; `handled` when it is done; `needs_decision` when it needs ' +
      'your answer; `failed` when it could not be handled.'
  ),
  intent: z.string(),
  url: z.string().nullable(),
  text: z.string().nullable(),
  file_ids: z.array(z.string()),
  result: z
    .string()
    .max(DELEGATION_LIMITS.result)
    .nullable()
    .describe('What the assistant did, or the decision it needs; null while pending or after a failure.'),
  created_at: z.string().describe('ISO 8601 timestamp.'),
  settled_at: z.string().nullable().describe('ISO 8601 timestamp; null while pending.'),
});
export type Delegation = z.infer<typeof DelegationSchema>;

export const DelegationIdParamSchema = z.object({
  id: z.string().min(1).describe('The delegation id returned by `POST /api/v1/delegations`.'),
});
