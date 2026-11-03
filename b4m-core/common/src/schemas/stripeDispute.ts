import { z } from 'zod';

/**
 * Stripe disputes as the platform tracks them, one record per Stripe dispute id, so a dispute that
 * cannot be settled automatically (an organization's subscription payment, or a payment with no
 * matching account) has an admin queue instead of only a Slack post. The Stripe webhook writes the
 * record (apps/client/server/billing/stripeDisputes.ts); the admin Disputes page reads and resolves it.
 *
 * Only a won dispute ever clears an account's dispute flag. A lost dispute on a user's payment is
 * resolved by the system and contains the account (suspend, zero credits, revoke API keys) with an
 * undo kept on this record; the dispute flag stays set either way.
 */

/** Who the disputed payment belongs to, as far as the webhook could tell. */
export const STRIPE_DISPUTE_SUBJECTS = ['user', 'organization', 'unmatched'] as const;
export type StripeDisputeSubject = (typeof STRIPE_DISPUTE_SUBJECTS)[number];

/** Subjects an admin resolves by hand; a user's dispute resolves from its Stripe outcome. */
export const STRIPE_DISPUTE_ADMIN_RESOLVABLE: readonly StripeDisputeSubject[] = ['organization', 'unmatched'];

/**
 * Whether an admin may close this dispute by hand: an open organization or unmatched dispute, or any
 * open dispute Stripe has already closed without the system resolving it (an inquiry closed as
 * warning_closed, or a user the close could no longer find). A user's dispute Stripe has not closed
 * yet is refused, so a manual resolve never pre-empts the lost-dispute Contain.
 */
export const isStripeDisputeAdminResolvable = (dispute: {
  state: StripeDisputeState;
  subject: StripeDisputeSubject;
  closedAt: Date | string | null;
}): boolean =>
  dispute.state === 'open' && (STRIPE_DISPUTE_ADMIN_RESOLVABLE.includes(dispute.subject) || dispute.closedAt !== null);

export const STRIPE_DISPUTE_STATES = ['open', 'resolved'] as const;
export type StripeDisputeState = (typeof STRIPE_DISPUTE_STATES)[number];

/** `admin` is a manual resolution of an organization or unmatched dispute. */
export const STRIPE_DISPUTE_OUTCOMES = ['won', 'lost', 'admin'] as const;
export type StripeDisputeOutcome = (typeof STRIPE_DISPUTE_OUTCOMES)[number];

/** Disputes returned by one list request; the table pages locally, `truncated` says the cap was hit. */
export const STRIPE_DISPUTE_LIST_LIMIT = 500;

const ObjectIdStringSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Not a valid id');

export const stripeDisputeResolutionSchema = z.object({
  outcome: z.enum(STRIPE_DISPUTE_OUTCOMES),
  /** The admin's user id, or null when the system resolved it from the Stripe outcome. */
  resolvedBy: z.string().nullable(),
  note: z.string().nullable(),
  resolvedAt: z.date(),
});
export type StripeDisputeResolution = z.infer<typeof stripeDisputeResolutionSchema>;

/** The automatic Contain a lost dispute applied, and its undo. */
export const stripeDisputeContainSchema = z.object({
  batchId: z.string(),
  containedAt: z.date(),
  suspended: z.boolean(),
  /** Signed ledger delta; zero when the balance was already empty. */
  creditDelta: z.number(),
  apiKeysRevoked: z.number().int(),
  undoneAt: z.date().nullable(),
  undoneBy: z.string().nullable(),
});
export type StripeDisputeContain = z.infer<typeof stripeDisputeContainSchema>;

export const stripeDisputeItemSchema = z.object({
  id: z.string(),
  stripeDisputeId: z.string(),
  chargeId: z.string().nullable(),
  paymentIntentId: z.string().nullable(),
  /** Minor units of `currency`. */
  amount: z.number(),
  /** Stripe's lowercase ISO code. */
  currency: z.string(),
  reason: z.string(),
  /** The last status Stripe reported, e.g. needs_response, won, lost. */
  stripeStatus: z.string(),
  subject: z.enum(STRIPE_DISPUTE_SUBJECTS),
  /** The user or organization id; null when unmatched. */
  subjectId: z.string().nullable(),
  state: z.enum(STRIPE_DISPUTE_STATES),
  openedAt: z.date(),
  closedAt: z.date().nullable(),
  resolution: stripeDisputeResolutionSchema.nullable(),
  contain: stripeDisputeContainSchema.nullable(),
});
export type StripeDisputeItem = z.infer<typeof stripeDisputeItemSchema>;

export const stripeDisputeListSchema = z.object({
  data: z.array(stripeDisputeItemSchema),
  truncated: z.boolean(),
});
export type StripeDisputeList = z.infer<typeof stripeDisputeListSchema>;

export const stripeDisputeListQuerySchema = z.object({
  state: z.enum(STRIPE_DISPUTE_STATES).optional(),
  subject: z.enum(STRIPE_DISPUTE_SUBJECTS).optional(),
});
export type StripeDisputeListQuery = z.infer<typeof stripeDisputeListQuerySchema>;

/** The reason is validated by the shared admin reason rule on the server. */
export const stripeDisputeResolveRequestSchema = z.object({
  id: ObjectIdStringSchema,
  reason: z.unknown(),
});
export type StripeDisputeResolveRequest = z.infer<typeof stripeDisputeResolveRequestSchema>;

export const stripeDisputeUndoContainRequestSchema = z.object({
  id: ObjectIdStringSchema,
  reason: z.unknown(),
});
export type StripeDisputeUndoContainRequest = z.infer<typeof stripeDisputeUndoContainRequestSchema>;
