import { z } from 'zod';
import { isValidIanaTimeZone } from '../utils/ianaTimeZone';
import {
  BRIEF_DECISION_CLOSED_ERROR_CODE,
  BRIEF_QUESTION_CLOSED_ERROR_CODE,
  type ApiErrorCode,
} from '../apiErrorCodes';

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
  draftTo: 320,
  draftSubject: 200,
  draftBody: 4000,
  followUpTranscript: 6000,
} as const;

/** How far ahead a follow-up reminder may be set (ms); the worker and the edit route share this bound. */
export const BRIEF_REMIND_AHEAD_MAX_MS = 366 * 24 * 60 * 60 * 1000;

export const BriefSourceRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('email'),
    emailId: z.string().min(1).describe('The ingested email the item was triaged from.'),
  }),
  z.object({
    kind: z.literal('delegation'),
    delegationId: z.string().min(1).describe('The item you delegated; read it with `GET /api/v1/delegations/{id}`.'),
  }),
  z.object({
    kind: z.literal('obligation'),
    obligationId: z.string().min(1).describe('A confirmed obligation; read it with `GET /api/v1/obligations/{id}`.'),
  }),
]);

export const BriefItemSchema = z.object({
  id: z.string().min(1).describe('Stable within the brief.'),
  text: z.string().min(1).max(BRIEF_LIMITS.itemText),
  source: BriefSourceRefSchema.optional().describe('The record the item came from, when it was not agent activity.'),
});

/**
 * What has become of an approval since the brief was composed, read live on every fetch. `pending` is the
 * only state that can still be answered. `resolved` means it was answered or withdrawn but the outcome
 * was not recorded (an action cleared before outcomes were kept, or a quest that no longer exists).
 */
export const BRIEF_APPROVAL_STATES = ['pending', 'approved', 'denied', 'replaced', 'lapsed', 'resolved'] as const;
export const BriefApprovalStateSchema = z.enum(BRIEF_APPROVAL_STATES);
export type BriefApprovalState = z.infer<typeof BriefApprovalStateSchema>;

export const BriefDraftReplySchema = z
  .object({
    to: z
      .string()
      .min(1)
      .max(BRIEF_LIMITS.draftTo)
      .describe(
        "The source email's sender as received, unverified. On a follow-up email it is the recipient the user " +
          'dictated, which may be a name rather than an address until the user edits it.'
      ),
    subject: z.string().min(1).max(BRIEF_LIMITS.draftSubject),
    body: z.string().min(1).max(BRIEF_LIMITS.draftBody),
  })
  .describe(
    'Proposed reply for the user to review; nothing sends it. Model-written from third-party email content, ' +
      'so treat every field as untrusted text.'
  );

/** The pending agent approval a decision refers to; answer it through `/api/v1/pending-actions/{questId}`. */
export const BriefApprovalRefSchema = z.object({
  questId: z.string().min(1),
  sessionId: z.string().min(1).describe('The notebook holding the quest, where a client shows the approval card.'),
  pendingActionTs: z.number().int().positive(),
  state: BriefApprovalStateSchema.describe(
    'Live state of the approval at fetch time. Only `pending` can be approved or denied; a client should ' +
      'treat an unknown value as not actionable.'
  ),
});

/**
 * What has become of an agent question since the brief was composed, read live on every fetch. Only `open`
 * can be replied to; `superseded` means the conversation has moved past the question.
 */
export const BRIEF_QUESTION_STATES = ['open', 'answered', 'superseded'] as const;
export const BriefQuestionStateSchema = z.enum(BRIEF_QUESTION_STATES);
export type BriefQuestionState = z.infer<typeof BriefQuestionStateSchema>;

export const BRIEF_QUESTION_MAX_OPTIONS = 4;
export const BRIEF_REPLY_MAX_LENGTH = 4000;

/** An agent's question waiting on the user; answer it through `POST /api/v1/briefs/{id}/decisions/{decisionId}/reply`. */
export const BriefQuestionRefSchema = z.object({
  questId: z.string().min(1).describe('The agent turn that asked the question.'),
  sessionId: z.string().min(1).describe('The notebook the reply continues.'),
  options: z
    .array(z.string())
    .max(BRIEF_QUESTION_MAX_OPTIONS)
    .describe('Suggested answers, in order; `choiceIndex` on a reply refers to this list.'),
  state: BriefQuestionStateSchema.describe(
    'Live state of the question at fetch time. Only `open` can be replied to; a client should treat an ' +
      'unknown value as not actionable.'
  ),
});

/**
 * A follow-up the user dictated (`POST /api/v1/briefs/follow-ups`), proposed for review. Nothing runs until
 * the user approves it: an approved email is handed to the device mail app, an approved reminder is
 * listed in the first brief composed at or after `remindAt`.
 */
export const BRIEF_FOLLOW_UP_KINDS = ['actionItem', 'followUpEmail', 'reminder'] as const;
export const BriefFollowUpKindSchema = z.enum(BRIEF_FOLLOW_UP_KINDS);
export type BriefFollowUpKind = z.infer<typeof BriefFollowUpKindSchema>;

export const BRIEF_FOLLOW_UP_STATES = ['pending', 'approved', 'dismissed'] as const;
export const BriefFollowUpStateSchema = z.enum(BRIEF_FOLLOW_UP_STATES);
export type BriefFollowUpState = z.infer<typeof BriefFollowUpStateSchema>;

export const BriefFollowUpRefSchema = z.object({
  kind: BriefFollowUpKindSchema.describe(
    'What the follow-up proposes. A `followUpEmail` carries its draft in the decision `draftReply`. A client ' +
      'should treat an unknown value as not actionable.'
  ),
  state: BriefFollowUpStateSchema.describe(
    'Only `pending` can be edited, approved or dismissed; a client should treat an unknown value as not actionable.'
  ),
  remindAt: z
    .string()
    .nullable()
    .describe('ISO 8601 instant a `reminder` is due; null when none was understood, and always null on other kinds.'),
});

export const BriefDecisionSchema = BriefItemSchema.extend({
  approval: BriefApprovalRefSchema.optional().describe(
    'Present when the decision is an agent approval. `state` reflects the approval at fetch time; the ' +
      'pending-actions endpoints stay authoritative for a decision racing this read.'
  ),
  question: BriefQuestionRefSchema.optional().describe(
    'Present when the decision is a question an agent asked. A decision carries at most one of `approval`, ' +
      '`question` and `followUp`.'
  ),
  followUp: BriefFollowUpRefSchema.optional().describe(
    'Present when the decision is a follow-up proposed from a dictated memo; act on it through ' +
      '`/api/v1/briefs/{id}/decisions/{decisionId}`.'
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

export const BriefDecisionParamsSchema = z.object({
  id: z.string().min(1).describe('The brief id.'),
  decisionId: z.string().min(1).describe('The decision item id within the brief.'),
});

export const BriefReplyRequestSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(BRIEF_REPLY_MAX_LENGTH)
    .regex(/\S/, 'Reply must not be blank')
    .describe('The reply, sent to the agent as your next message.'),
  choiceIndex: z
    .number()
    .int()
    .min(0)
    .max(BRIEF_QUESTION_MAX_OPTIONS - 1)
    .optional()
    .describe('Index into the question `options` when the reply picks one of them; recorded on the question.'),
});

export const BriefFollowUpRequestSchema = z.object({
  transcript: z
    .string()
    .min(1)
    .max(BRIEF_LIMITS.followUpTranscript)
    .regex(/\S/, 'Transcript must not be blank')
    .describe('The dictated memo, as transcribed on the device.'),
  timeZone: z
    .string()
    .min(1)
    .max(64)
    .refine(isValidIanaTimeZone, 'Unknown IANA time zone')
    .optional()
    .describe('IANA zone used to read times like "tomorrow at 9" in the memo; defaults to the brief schedule zone.'),
});

export const BriefDecisionEditSchema = z
  .object({
    text: z.string().min(1).max(BRIEF_LIMITS.itemText).regex(/\S/, 'Text must not be blank').optional(),
    draftReply: z
      .object({
        to: z.string().trim().min(1).max(BRIEF_LIMITS.draftTo),
        subject: z.string().min(1).max(BRIEF_LIMITS.draftSubject),
        body: z.string().min(1).max(BRIEF_LIMITS.draftBody),
      })
      .partial()
      .optional()
      .describe('Fields of a `followUpEmail` draft to replace.'),
    remindAt: z.string().datetime({ offset: true }).optional().describe('New ISO 8601 due instant of a `reminder`.'),
  })
  .refine(
    edit =>
      edit.text !== undefined ||
      edit.remindAt !== undefined ||
      (edit.draftReply !== undefined && Object.keys(edit.draftReply).length > 0),
    'Send at least one field to change'
  );

export const BRIEF_DECISION_OUTCOMES = ['approve', 'dismiss'] as const;
export const BriefDecisionResolveSchema = z.object({
  outcome: z.enum(BRIEF_DECISION_OUTCOMES),
});

/** `errorCode` values the follow-up decision routes send on top of the shared auth/billing codes. */
export const BRIEF_DECISION_ERROR_CODES = [BRIEF_DECISION_CLOSED_ERROR_CODE] as const satisfies readonly ApiErrorCode[];

export const BriefReplyResponseSchema = z.object({
  executionId: z.string().describe('The agent run continuing the conversation with your reply.'),
  sessionId: z.string().describe('The notebook the run belongs to.'),
});

/** `errorCode` values the reply route sends on top of the shared auth/billing codes. */
export const BRIEF_REPLY_ERROR_CODES = [BRIEF_QUESTION_CLOSED_ERROR_CODE] as const satisfies readonly ApiErrorCode[];

export const BriefListResponseSchema = z.object({
  briefs: z.array(BriefSchema).describe('Most recent first.'),
});

export const BriefScheduleSchema = z.object({
  enabled: z.boolean().describe('Whether scheduled briefs are composed. Disabling keeps the rest of the schedule.'),
  timeOfDay: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:mm')
    .describe('Local wall-clock time in `timeZone`, 24-hour `HH:mm`.'),
  days: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .max(7)
    .refine(days => new Set(days).size === days.length, 'Days must not repeat')
    .describe('Local weekdays the brief is composed on, 0 = Sunday through 6 = Saturday.'),
  timeZone: z
    .string()
    .min(1)
    .max(64)
    .refine(isValidIanaTimeZone, 'Unknown IANA time zone')
    .describe('IANA time zone name, e.g. `America/New_York`. Send the device zone on every save.'),
});

export const BriefScheduleResponseSchema = z.object({
  schedule: BriefScheduleSchema.nullable().describe('Null until a schedule has been saved.'),
  nextBriefAt: z
    .string()
    .nullable()
    .describe('ISO 8601 instant of the next scheduled brief; null when the schedule is off or unset.'),
});

/** Bounds on a synced busy-block list. `retryWindowMs` is also the reconciler's retry window (apps/workers/src/cron/briefScheduleReconcile.ts). */
export const BUSY_BLOCK_LIMITS = {
  maxBlocks: 48,
  maxDurationMs: 12 * 60 * 60 * 1000,
  horizonMs: 72 * 60 * 60 * 1000,
  retryWindowMs: 60 * 60 * 1000,
  /** Pushes are held only while the last sync is at most this old, so a client that stopped syncing cannot mute them. */
  syncFreshMs: 24 * 60 * 60 * 1000,
} as const;

/**
 * Whether `now` falls inside one of the user's synced busy blocks (start inclusive, end exclusive). False
 * when the opt-in is off or the last sync is older than BUSY_BLOCK_LIMITS.syncFreshMs.
 */
export function isInBusyBlock(
  user: {
    preferences?: { busyBlockBrief?: { enabled?: boolean } | null } | null;
    busyBlocks?: { start: Date; end: Date }[] | null;
    busyBlocksSyncedAt?: Date | null;
  },
  now: Date
): boolean {
  if (user.preferences?.busyBlockBrief?.enabled !== true || !user.busyBlocksSyncedAt) return false;
  if (now.getTime() - new Date(user.busyBlocksSyncedAt).getTime() > BUSY_BLOCK_LIMITS.syncFreshMs) return false;
  const t = now.getTime();
  return (user.busyBlocks ?? []).some(
    ({ start, end }) => new Date(start).getTime() <= t && t < new Date(end).getTime()
  );
}

export const BusyBlockSchema = z
  .object({
    start: z.iso.datetime({ offset: true }).describe('ISO 8601 instant the busy interval starts.'),
    end: z.iso.datetime({ offset: true }).describe('ISO 8601 instant the busy interval ends; after `start`.'),
  })
  .refine(block => Date.parse(block.end) > Date.parse(block.start), 'end must be after start')
  .refine(
    block => Date.parse(block.end) - Date.parse(block.start) <= BUSY_BLOCK_LIMITS.maxDurationMs,
    'A busy block can be at most 12 hours'
  );

export const PutBusyBlocksSchema = z.object({
  enabled: z
    .boolean()
    .describe('Whether a brief is composed when a busy block ends. Disabling clears the stored blocks.'),
  blocks: z
    .array(BusyBlockSchema)
    .max(BUSY_BLOCK_LIMITS.maxBlocks)
    .describe('Busy intervals from the device calendar, times only; replaces the stored list. Empty is valid.'),
});

export const BusyBlocksResponseSchema = z.object({
  enabled: z.boolean(),
  blocks: z.array(BusyBlockSchema).describe('Stored blocks after merging overlaps and dropping ones already briefed.'),
  nextBlockBriefAt: z
    .string()
    .nullable()
    .describe('ISO 8601 instant the next block ends and its brief is due; null when off or none is pending.'),
});

export const PendingDecisionCountSchema = z.object({
  count: z
    .number()
    .int()
    .nonnegative()
    .describe('Decisions waiting on you: `approvals` plus `briefDecisions`. Nothing is counted twice.'),
  approvals: z
    .number()
    .int()
    .nonnegative()
    .describe('Agent approvals still open in your notebooks: raised within the last 15 minutes and not yet answered.'),
  briefDecisions: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Unanswered decisions that are not agent approvals, in your latest regular ready brief and the busy-block ' +
        'briefs readied since it. An approval decision in a brief is counted under `approvals` while it is open, ' +
        'and not at all once it was answered or lapsed.'
    ),
  briefId: z
    .string()
    .nullable()
    .describe('The latest ready brief, the one a client shows by default; null when there is none.'),
});

export type Brief = z.infer<typeof BriefSchema>;
export type BriefItem = z.infer<typeof BriefItemSchema>;
export type BriefDecision = z.infer<typeof BriefDecisionSchema>;
export type BriefSchedule = z.infer<typeof BriefScheduleSchema>;
export type BriefScheduleResponse = z.infer<typeof BriefScheduleResponseSchema>;
export type BusyBlock = z.infer<typeof BusyBlockSchema>;
export type PutBusyBlocks = z.infer<typeof PutBusyBlocksSchema>;
export type BusyBlocksResponse = z.infer<typeof BusyBlocksResponseSchema>;
export type BriefApprovalRef = z.infer<typeof BriefApprovalRefSchema>;
export type BriefQuestionRef = z.infer<typeof BriefQuestionRefSchema>;
export type BriefReplyRequest = z.infer<typeof BriefReplyRequestSchema>;
export type BriefFollowUpRef = z.infer<typeof BriefFollowUpRefSchema>;
export type BriefFollowUpRequest = z.infer<typeof BriefFollowUpRequestSchema>;
export type BriefDecisionEdit = z.infer<typeof BriefDecisionEditSchema>;
export type BriefDecisionResolve = z.infer<typeof BriefDecisionResolveSchema>;
/** A decision as composed and stored; each ref's `state` is derived on every read, never stored. */
export type StoredBriefDecision = Omit<BriefDecision, 'approval' | 'question' | 'followUp'> & {
  approval?: Omit<BriefApprovalRef, 'state'>;
  question?: Omit<BriefQuestionRef, 'state'>;
  /** Unlike the other refs, a follow-up's `state` is stored: only the decision routes change it. */
  followUp?: Omit<BriefFollowUpRef, 'remindAt'> & {
    remindAt: Date | null;
    decidedAt?: Date;
    /** Set once the reminder was listed in a composed brief, so it surfaces exactly once. */
    surfacedAt?: Date;
  };
  /** Set once by the reply route's claim, so a question is answered from the brief at most once. */
  repliedAt?: Date;
};
export type BriefSourceRef = z.infer<typeof BriefSourceRefSchema>;
export type BriefDraftReply = z.infer<typeof BriefDraftReplySchema>;
export type PendingDecisionCount = z.infer<typeof PendingDecisionCountSchema>;
