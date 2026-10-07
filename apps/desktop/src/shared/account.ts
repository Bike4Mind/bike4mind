/**
 * The caller's own commercial state, as it crosses the contextBridge.
 *
 * Credential-free like the rest of the bridge: the balance is read in main with the access
 * token it already holds, and only the number comes back. See src/shared/ipc.ts.
 */

/**
 * What `GET /api/v1/me` says about the signed-in account's credits.
 *
 * `balance` null means the figure could not be READ - signed out, offline, server error - and
 * says nothing about how many credits the account has. Zero is a real balance and a different
 * state entirely, which is why this is nullable rather than defaulted; a stand-in zero would
 * claim the account is spent when nobody asked.
 *
 * The number is the caller's PERSONAL ledger. A turn billed to an organization draws on a pool
 * it does not describe, per the endpoint's own contract - so nothing here treats a zero as
 * proof that the next turn will be refused.
 */
export interface AccountCredits {
  balance: number | null;
  /** Set when the read failed. Present with a null balance, never with a real one. */
  error?: string;
}

/** The caller's active subscription, as `GET /api/v1/me` states it. */
export interface AccountPlan {
  name: string;
  interval: 'monthly' | 'yearly';
  /** ISO 8601. When the current billing period ENDS - not a cancellation date. */
  currentPeriodEndsAt: string;
}

/**
 * Rung on the plan ladder, straight off the wire. `free` is no subscription; `other` is still a
 * paying account whose plan this deployment cannot name, which is the one case where a null
 * `plan` must not be read as "not paying".
 */
export type AccountTier = 'free' | 'basic' | 'pro' | 'other';

/** The caller's own commercial state: what they hold, and what they are on. */
export interface AccountProfile {
  credits: AccountCredits;
  /** Null when the deployment named no plan. `tier` is what tells free from unnameable. */
  plan: AccountPlan | null;
  /** Null when the read failed, or when the server stated no tier. */
  tier: AccountTier | null;
}
