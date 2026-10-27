import { z } from 'zod';
import { normalizeEmailDomain } from '../utils/emailDomain';

/**
 * Users acted on per request. A domain cohort past this continues with `afterUserId`; the cap keeps
 * one execute (a transaction per user) inside a single API request's time budget.
 */
export const MAX_BULK_ABUSE_BATCH = 200;

/** Users listed by name in a preview; the counts cover the whole batch. */
export const BULK_ABUSE_SAMPLE_SIZE = 20;

const ObjectIdStringSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Not a valid user id');

export const BulkAbuseTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('domain'),
    domain: z.string().refine(value => normalizeEmailDomain(value) !== null, 'Not a valid domain'),
    /** Continuation cursor: only users created after this id (ids sort by creation). */
    afterUserId: ObjectIdStringSchema.optional(),
  }),
  z.object({
    kind: z.literal('users'),
    userIds: z.array(ObjectIdStringSchema).min(1).max(MAX_BULK_ABUSE_BATCH),
  }),
]);
export type BulkAbuseTarget = z.infer<typeof BulkAbuseTargetSchema>;

export const BulkAbuseActionsSchema = z
  .object({
    ban: z.boolean(),
    revokeApiKeys: z.boolean(),
    revokeSessions: z.boolean(),
    clawbackFreeCredits: z.boolean(),
  })
  .refine(actions => Object.values(actions).some(Boolean), 'Select at least one action');
export type BulkAbuseActions = z.infer<typeof BulkAbuseActionsSchema>;
export type BulkAbuseAction = keyof BulkAbuseActions;

export const BulkAbusePreviewRequestSchema = z.object({
  target: BulkAbuseTargetSchema,
  actions: BulkAbuseActionsSchema,
});
export type BulkAbusePreviewRequest = z.infer<typeof BulkAbusePreviewRequestSchema>;

export const BulkAbuseExecuteRequestSchema = BulkAbusePreviewRequestSchema.extend({
  previewToken: z.string().min(1),
  reason: z.string(),
});
export type BulkAbuseExecuteRequest = z.infer<typeof BulkAbuseExecuteRequestSchema>;

export type BulkAbuseExclusionReason = 'self' | 'admin' | 'system' | 'org_owner' | 'org_member' | 'paid' | 'not_found';

export type BulkAbuseUserSummary = {
  id: string;
  email: string | null;
  username: string;
  isBanned: boolean;
  currentCredits: number;
};

export type BulkAbuseExclusion = {
  userId: string;
  email: string | null;
  reason: BulkAbuseExclusionReason;
};

type BulkAbuseBatch = {
  excluded: BulkAbuseExclusion[];
  /** More users match the domain past this batch; continue with `afterUserId: nextAfterUserId`. */
  hasMore: boolean;
  nextAfterUserId: string | null;
};

export type BulkAbusePreview = BulkAbuseBatch & {
  includedCount: number;
  sample: BulkAbuseUserSummary[];
  alreadyBannedCount: number;
  activeApiKeyCount: number;
  /** Credits the clawback would remove: per user, min(balance, signup grant), less any prior clawback. */
  clawbackCredits: number;
  /** A domain ban also adds the domain to the blockedEmailDomains setting. */
  blocksDomain: string | null;
  /** Execute must send this back; it binds the admin, target, actions and included users. */
  previewToken: string;
};

export type BulkAbuseStepOutcome = 'applied' | 'skipped' | 'not_requested';

export type BulkAbuseUserResult = {
  userId: string;
  email: string | null;
  status: 'succeeded' | 'failed';
  steps: Record<BulkAbuseAction, BulkAbuseStepOutcome>;
  revokedApiKeys: number;
  clawedBackCredits: number;
  error?: string;
};

export type BulkAbuseExecuteResult = BulkAbuseBatch & {
  results: BulkAbuseUserResult[];
  succeededCount: number;
  failedCount: number;
  bannedCount: number;
  revokedApiKeyCount: number;
  clawedBackCredits: number;
  blockedDomain: string | null;
};
