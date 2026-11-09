import * as z from 'zod';

/**
 * GET /api/admin/users/[userId]/signup-grant-pending: what an account still has coming from the signup
 * grant, for the profile Credits tab. It is the only place an admin reads the block flag, because the
 * user's own payload and websocket copy never carry it.
 */

/** One admin action: whether it would change anything now, and why not when it would not. */
export const adminSignupGrantActionStateSchema = z.object({
  /** The account is in a state where the action applies. */
  available: z.boolean(),
  /** The no-op reason (see SignupGrantNoopReason in services) when `available` is false. */
  reason: z.string().nullable(),
  /** False when the viewing admin may see the action but not run it. */
  permitted: z.boolean(),
});
export type AdminSignupGrantActionState = z.infer<typeof adminSignupGrantActionStateSchema>;

export const adminSignupGrantPendingSchema = z.object({
  hasGrant: z.boolean(),
  /** `package` when the account redeemed a grant package at signup. */
  source: z.enum(['default', 'package']).nullable(),
  stage: z.enum(['pending_email', 'signup', 'unlocked']).nullable(),
  schedule: z
    .object({
      signupCredits: z.number(),
      unlockCredits: z.number(),
      /** Credits paid out of the grant so far. */
      received: z.number(),
      /** Credits the activity drip has paid so far. */
      dripped: z.number(),
      dripCap: z.number(),
      dailyCredits: z.number(),
      /** Still to come from the grant: signup + unlock - received, under the live cap. */
      remaining: z.number(),
      /** Still to come from the drip alone: the live cap minus what it has paid. */
      dripRemaining: z.number(),
    })
    .nullable(),
  /** A tranche waiting on the pool or on review; `credits` is 0 when the amount is not recorded. */
  held: z
    .object({
      reason: z.enum(['budget_exhausted', 'risk_review']).nullable(),
      since: z.string().nullable(),
      credits: z.number(),
    })
    .nullable(),
  /** A payment unlock waiting for its payment to settle. */
  heldUnlock: z.object({ reason: z.string(), releaseAt: z.string() }).nullable(),
  /** A disputed, refunded or fraud-warned payment: only an admin can release more. */
  forfeited: z.object({ cause: z.string(), at: z.string() }).nullable(),
  blocked: z.object({ at: z.string() }).nullable(),
  rewards: z.object({
    queuedCount: z.number(),
    queuedCredits: z.number(),
    pausedCount: z.number(),
    pausedCredits: z.number(),
  }),
  /** UTC day (YYYY-MM-DD) of the latest activity drip payout. */
  lastActivityCreditDay: z.string().nullable(),
  actions: z.object({
    releaseHeld: adminSignupGrantActionStateSchema,
    releaseRemaining: adminSignupGrantActionStateSchema,
    block: adminSignupGrantActionStateSchema,
    unblock: adminSignupGrantActionStateSchema,
  }),
});
export type AdminSignupGrantPending = z.infer<typeof adminSignupGrantPendingSchema>;

/** One row of the Invite Center pending list (GET /api/admin/signup-grants/pending). */
export const adminSignupGrantPendingRowSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  createdAt: z.string().nullable(),
  source: z.enum(['default', 'package']).nullable(),
  stage: z.enum(['pending_email', 'signup', 'unlocked']).nullable(),
  /** `locked`: credits remain but nothing pays them without an unlock or an admin. */
  status: z.enum(['held', 'dripping', 'locked', 'blocked']),
  held: z
    .object({
      reason: z.enum(['budget_exhausted', 'risk_review']).nullable(),
      since: z.string().nullable(),
      credits: z.number(),
    })
    .nullable(),
  blocked: z.object({ at: z.string().nullable() }).nullable(),
  /** Same math as the profile pending card's `schedule.remaining`, under the live drip cap. */
  remaining: z.number(),
  dripRemaining: z.number(),
  rewards: z.object({
    queuedCount: z.number(),
    queuedCredits: z.number(),
    pausedCount: z.number(),
    pausedCredits: z.number(),
  }),
});
export type AdminSignupGrantPendingRow = z.infer<typeof adminSignupGrantPendingRowSchema>;

export const adminSignupGrantPendingListSchema = z.object({
  data: z.array(adminSignupGrantPendingRowSchema),
  nextCursor: z.string().nullable(),
  /** Bulk release is full-admin only; delegated credit admins can list and block. */
  viewer: z.object({ canRelease: z.boolean() }),
});
export type AdminSignupGrantPendingList = z.infer<typeof adminSignupGrantPendingListSchema>;

/** Each part is null when its read failed, so one bad read blanks one tile rather than the whole header. */
export const adminSignupGrantPendingSummarySchema = z.object({
  exposure: z
    .object({ accountsWithRemaining: z.number(), totalRemaining: z.number(), totalDripRemaining: z.number() })
    .nullable(),
  trickle: z.object({ day: z.string(), spentToday: z.number(), limit: z.number(), missing: z.boolean() }).nullable(),
  queue: z.object({ held: z.number(), oldestHeldAt: z.string().nullable() }).nullable(),
});
export type AdminSignupGrantPendingSummary = z.infer<typeof adminSignupGrantPendingSummarySchema>;
