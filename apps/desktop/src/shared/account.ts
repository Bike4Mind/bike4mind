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
  /** Backend-stated grant for one monthly plan cycle. Null means no finite allowance was stated. */
  monthlyAllowance: number | null;
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

export interface AccountBillingPlan {
  priceId: string;
  name: string;
  description: string;
  credits: number;
  interval: 'monthly' | 'yearly';
  priceCents: number | null;
  currency: 'usd';
  features: string[];
}

export interface AccountBillingSubscription {
  priceId: string;
  subscriptionId: string | null;
  status: string;
  periodEndsAt: string | null;
  canceledAt: string | null;
}

export interface AccountBilling {
  billingEnabled: boolean;
  balance?: number | null;
  plans: AccountBillingPlan[];
  creditPackages?: { id: string; price: number; credits: number; description: string }[];
  /** A credit purchase must send acceptedTerms: true; termsUrl is the page the checkbox links to. */
  termsConsentRequired?: boolean;
  termsUrl?: string;
  /** Non-terminal subscriptions, active first. Any row blocks a new checkout. */
  subscriptions: AccountBillingSubscription[];
  error?: string;
}

/** Success means checkout opened, not that a payment completed. */
export type SubscribePlanResult = { ok: true } | { ok: false; error: string };
