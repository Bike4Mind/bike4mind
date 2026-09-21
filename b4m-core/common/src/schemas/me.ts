import { z } from 'zod';

/**
 * Public wire schema for `GET /api/v1/me` - the caller's own identity and
 * commercial state, and nothing else.
 *
 * Deliberately narrower than the user document `/api/identify` returns: no email,
 * no tags, no internal flags. Everything here answers one of three questions a
 * downstream app has to ask before it spends - who is this, what have they paid
 * for, can they afford the next call.
 *
 * Public-API rules apply: snake_case wire fields, no `.catch()`, no top-level
 * `.transform()`.
 */

/**
 * Rung on the B4M plan ladder the caller currently sits on.
 *
 * `free` means no active subscription. `other` is still a paying customer: either
 * an active plan that is not on the ladder (`SubscriptionPlanDetail.tier` is
 * optional - a standalone product omits it so it stays out of the cross-plan
 * change flow), or one whose Stripe price the deployment can no longer name, as
 * happens to a subscriber grandfathered on a superseded price. `subscription` is
 * `null` in that second case.
 *
 * Gate on `tier !== 'free'` for "is this caller paying" and on `subscription.
 * price_id` for "which product" - NOT on `basic`/`pro`, whose ordinals come from
 * the internal change-flow ladder and do not track a plan's marketing name (the
 * Professional plan occupies the `basic` rung today).
 */
export const ME_TIERS = ['free', 'basic', 'pro', 'other'] as const;
export type MeTier = (typeof ME_TIERS)[number];

/** The caller's active subscription, or `null` when they have none the deployment can name. */
export const MeSubscriptionSchema = z.object({
  plan_name: z.string(),
  price_id: z.string(),
  interval: z.enum(['monthly', 'yearly']),
  /** ISO 8601. When the current billing period ends - not a cancellation date. */
  current_period_ends_at: z.string(),
});

export type MeSubscription = z.infer<typeof MeSubscriptionSchema>;

export const MeResponseSchema = z.object({
  /** Stable B4M user id. Safe to key an integrator's own records on. */
  id: z.string(),
  /** Display name. Never the email address. */
  name: z.string(),
  tier: z.enum(ME_TIERS),
  subscription: MeSubscriptionSchema.nullable(),
  credits: z.object({
    /**
     * Spendable credits on the caller's PERSONAL ledger. Organization pools are not
     * included - a call billed to an organization draws on a balance this number
     * does not describe.
     */
    balance: z.number(),
  }),
  /** Entitlement keys the caller currently holds, e.g. `base`. */
  entitlements: z.array(z.string()),
});

export type MeResponse = z.infer<typeof MeResponseSchema>;
