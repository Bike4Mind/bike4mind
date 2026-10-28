import { z } from 'zod';
import { AdminActionReasonSchema } from '@bike4mind/common';
import { AdminUsersFilterSchema } from './adminUsersFilter';

/**
 * Contract for the users-list bulk actions, shared by the client and
 * `pages/api/admin/users/bulk/*`. Pure and React-free: the server imports it.
 */

/** Hard ceiling on users touched by one batch; a larger cohort is refused, not truncated. */
export const ADMIN_USERS_BULK_MAX = 500;
export const ADMIN_USERS_BULK_UNDO_WINDOW_MS = 30_000;
/** Per-user ceiling for an "add credits" batch, so one click cannot mint unbounded credits. */
export const ADMIN_USERS_BULK_MAX_CREDIT_ADD = 100_000;
/** Ceiling on the net credits one batch may add across all its users; a larger batch is refused. */
export const ADMIN_USERS_BULK_MAX_CREDIT_TOTAL = 1_000_000;

// Lowercase only: an uppercase hex id would slip past string comparisons against stored ids.
const UserIdSchema = z.string().regex(/^[a-f0-9]{24}$/, 'Not a valid user id');

export const AdminUsersBulkTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ids'), userIds: z.array(UserIdSchema).min(1).max(ADMIN_USERS_BULK_MAX) }),
  z.object({ kind: z.literal('filter'), filter: AdminUsersFilterSchema }),
]);
export type AdminUsersBulkTarget = z.infer<typeof AdminUsersBulkTargetSchema>;

export const ADMIN_USERS_CREDIT_MODES = ['add', 'subtract', 'set'] as const;

export const AdminUsersBulkActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('suspend') }),
  z.object({ type: z.literal('restrict') }),
  z.object({
    type: z.literal('adjustCredits'),
    mode: z.enum(ADMIN_USERS_CREDIT_MODES),
    amount: z.number().int().min(0).max(ADMIN_USERS_BULK_MAX_CREDIT_ADD),
  }),
  z.object({ type: z.literal('revokeApiKeys') }),
  z.object({ type: z.literal('addTag'), tag: z.string().trim().min(1).max(64) }),
  /**
   * Suspend + set credits to 0 + revoke API keys, as one transaction per user. `blockEmailDomains`
   * also adds the users' owned email domains to blockedEmailDomains first, so no new account can sign up on them.
   */
  z.object({ type: z.literal('contain'), blockEmailDomains: z.boolean().optional() }),
]);
export type AdminUsersBulkAction = z.infer<typeof AdminUsersBulkActionSchema>;
export type AdminUsersBulkActionType = AdminUsersBulkAction['type'];

export const AdminUsersBulkPreviewRequestSchema = z.object({
  target: AdminUsersBulkTargetSchema,
  action: AdminUsersBulkActionSchema,
});
export type AdminUsersBulkPreviewRequest = z.infer<typeof AdminUsersBulkPreviewRequestSchema>;

/** True when the action includes Contain's email-domain step. */
export const blocksEmailDomains = (action: AdminUsersBulkAction): boolean =>
  action.type === 'contain' && action.blockEmailDomains === true;

/** The users' distinct email domains, grouped by what Contain's domain step does with them. */
export type AdminUsersBulkEmailDomains = {
  /** Would be added to blockedEmailDomains. */
  toBlock: string[];
  /** Already blocked, by themselves or through a parent domain. */
  alreadyBlocked: string[];
  /** Never blocked: public mailbox providers (gmail.com) and public suffixes. */
  notOwned: string[];
};

export type AdminUsersBulkPreview = {
  /** Users the target resolves to, before exclusions. */
  matched: number;
  /** Users the batch would act on. */
  eligible: number;
  /** Never acted on: the calling admin and other admins. */
  excluded: { self: number; admins: number };
  /** Eligible users already in the requested state; they are skipped, not re-written. */
  alreadyApplied: number;
  /** True when `eligible` exceeds ADMIN_USERS_BULK_MAX; execute refuses such a batch. */
  overCap: boolean;
  /** Active keys the batch would disable (revokeApiKeys, contain). */
  apiKeysToRevoke: number;
  /** Net credits the batch would remove (positive) or add (negative). */
  creditsDelta: number;
  /** True when the batch would add more than ADMIN_USERS_BULK_MAX_CREDIT_TOTAL net; execute refuses it. */
  creditsOverCap: boolean;
  /** sha256 of the sorted eligible ids; execute must echo it, so it acts on exactly these users. */
  cohortHash: string;
  /** Contain's domain step; null when the action does not block domains. */
  emailDomains: AdminUsersBulkEmailDomains | null;
  sample: { id: string; name: string | null; email: string | null }[];
};

export const AdminUsersBulkExecuteRequestSchema = AdminUsersBulkPreviewRequestSchema.extend({
  /** Same rule as every reason-required admin write (composed client-side with composeAdminReason). */
  reason: AdminActionReasonSchema,
  /** Client-generated; a replay with the same key returns the first result instead of acting again. */
  idempotencyKey: z.string().uuid(),
  /** The `eligible` count the admin confirmed; a different count at execute time is a 409. */
  expectedCount: z.number().int().min(1).max(ADMIN_USERS_BULK_MAX),
  /** The preview's `cohortHash`; a different set of eligible users at execute time is a 409. */
  cohortHash: z.string().regex(/^[a-f0-9]{64}$/, 'Not a valid cohort hash'),
});
export type AdminUsersBulkExecuteRequest = z.infer<typeof AdminUsersBulkExecuteRequestSchema>;

export type AdminUsersBulkResult = {
  batchId: string;
  applied: number;
  skipped: number;
  failed: { userId: string; error: string }[];
  /** True when the batch stopped at its time budget; `remaining` users were not attempted. */
  partial: boolean;
  remaining: number;
  /** ISO time after which undo is refused. */
  undoExpiresAt: string;
  /** Domains this batch added to blockedEmailDomains; undo removes exactly these. */
  blockedDomains: string[];
};

export const AdminUsersBulkUndoRequestSchema = z.object({ batchId: z.string().uuid() });

export type AdminUsersBulkUndoResult = {
  restored: number;
  failed: { userId: string; error: string }[];
  unblockedDomains: string[];
  /** Domains still blocked because removing them failed; a retried undo tries again. */
  stillBlockedDomains: string[];
  /** True when the undo stopped at its time budget; `remaining` users were not attempted. */
  partial: boolean;
  remaining: number;
};
