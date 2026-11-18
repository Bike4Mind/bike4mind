import { z } from 'zod';

/**
 * Wire schemas for assistant briefs (`/api/v1/briefs`). A brief is server-composed and platform
 * neutral: every client renders the same three sections (what happened, what was handled, what needs a
 * decision) instead of a transcript. The `brief_ready` push carries only the brief id; a client always
 * re-fetches the brief with its own credentials.
 */

export const BRIEF_STATUSES = ['composing', 'ready', 'failed'] as const;
export const BriefStatusSchema = z.enum(BRIEF_STATUSES);
export type BriefStatus = z.infer<typeof BriefStatusSchema>;

/** Bounds shared by the composer (which truncates to them) and the wire schema. */
export const BRIEF_LIMITS = {
  headline: 160,
  itemText: 400,
  itemsPerSection: 12,
  draftSubject: 200,
  draftBody: 4000,
} as const;

export const BriefSourceRefSchema = z.object({
  kind: z.enum(['email']),
  emailId: z.string().min(1).describe('The ingested email the item was triaged from.'),
});

export const BriefItemSchema = z.object({
  id: z.string().min(1).describe('Stable within the brief.'),
  text: z.string().min(1).max(BRIEF_LIMITS.itemText),
  source: BriefSourceRefSchema.optional().describe('The record the item came from, when it was not agent activity.'),
});

export const BriefDraftReplySchema = z
  .object({
    to: z.string().min(1),
    subject: z.string().min(1).max(BRIEF_LIMITS.draftSubject),
    body: z.string().min(1).max(BRIEF_LIMITS.draftBody),
  })
  .describe('Proposed reply for the user to review; nothing sends it.');

/** The pending agent approval a decision refers to; answer it through `/api/v1/pending-actions/{questId}`. */
export const BriefApprovalRefSchema = z.object({
  questId: z.string().min(1),
  sessionId: z.string().min(1).describe('The notebook holding the quest, where a client shows the approval card.'),
  pendingActionTs: z.number().int().positive(),
});

export const BriefDecisionSchema = BriefItemSchema.extend({
  approval: BriefApprovalRefSchema.optional().describe(
    'Present when the decision is an agent approval. The approval may have lapsed or been answered since the ' +
      'brief was composed; the pending-actions endpoints are authoritative.'
  ),
  draftReply: BriefDraftReplySchema.optional(),
});

export const BriefSchema = z.object({
  id: z.string().min(1),
  status: BriefStatusSchema,
  createdAt: z.string().describe('ISO 8601 timestamp.'),
  composedAt: z.string().nullable().describe('ISO 8601 timestamp; null until the brief is ready.'),
  periodStart: z.string().describe('ISO 8601 start of the activity window the brief covers.'),
  periodEnd: z.string().describe('ISO 8601 end of the activity window the brief covers.'),
  headline: z.string().max(BRIEF_LIMITS.headline).nullable(),
  happened: z.array(BriefItemSchema).max(BRIEF_LIMITS.itemsPerSection),
  handled: z.array(BriefItemSchema).max(BRIEF_LIMITS.itemsPerSection),
  decisions: z.array(BriefDecisionSchema).max(BRIEF_LIMITS.itemsPerSection),
});

export const BriefIdParamSchema = z.object({
  id: z.string().min(1).describe('The brief id, as carried by the `brief_ready` push.'),
});

export const BriefListResponseSchema = z.object({
  briefs: z.array(BriefSchema).describe('Most recent first.'),
});

export type Brief = z.infer<typeof BriefSchema>;
export type BriefItem = z.infer<typeof BriefItemSchema>;
export type BriefDecision = z.infer<typeof BriefDecisionSchema>;
export type BriefSourceRef = z.infer<typeof BriefSourceRefSchema>;
export type BriefDraftReply = z.infer<typeof BriefDraftReplySchema>;
