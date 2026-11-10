import type { DataHolderRegistry } from '../types';
import { FINANCIAL_RECORD, PAYMENT_DISPUTE, SIGNUP_GRANT_CLAIM, expiresAfterTtl } from './retention';

// Records the platform deletes on a short TTL are kept for operations, not under the statutory bookkeeping period.
const PAYMENT_ATTEMPT_REASON =
  'Checkout attempt kept for payment fraud screening and reconciliation (legitimate interest, GDPR Art. 6(1)(f))';
const CREDIT_HOLD_REASON =
  'Credit reservation kept until its charge settles, to reconcile the balance (legitimate interest, GDPR Art. 6(1)(f))';
const SPEND_ROLLUP_REASON =
  'Short-term spend bucket kept for spend alerts and cost reconciliation (legitimate interest, GDPR Art. 6(1)(f))';

export const billingHolders = {
  // Mostly conversation content (query, checkpoint, result, tool inputs). Its charge is already on
  // the credit ledger and usage events, so it is erased rather than retained as a financial record.
  AgentExecution: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    // DAG node ids of other executions, not users.
    unrelatedPaths: ['blockedBy'],
  },
  CreditGrantIdentityClaim: {
    kind: 'holder',
    // `ownerId` is immutable and uniquely indexed, so it cannot be cleared in place. The claim is what blocks a
    // repeat signup grant.
    references: [
      {
        path: 'ownerId',
        matchBy: 'userId',
        action: 'retain',
        ...SIGNUP_GRANT_CLAIM,
      },
    ],
  },
  CreditLot: {
    kind: 'holder',
    references: [
      {
        path: 'ownerId',
        matchBy: 'userId',
        where: { ownerType: 'User' },
        action: 'retain',
        ...FINANCIAL_RECORD,
      },
    ],
  },
  CreditTransaction: {
    kind: 'holder',
    references: [
      {
        path: 'ownerId',
        matchBy: 'userId',
        where: { ownerType: 'User' },
        action: 'retain',
        ...FINANCIAL_RECORD,
      },
      {
        path: 'recipientId',
        matchBy: 'userId',
        where: { recipientType: 'User' },
        action: 'retain',
        ...FINANCIAL_RECORD,
      },
      {
        path: 'senderId',
        matchBy: 'userId',
        where: { senderType: 'User' },
        action: 'retain',
        ...FINANCIAL_RECORD,
      },
      // Deprecated alias of ownerId, still present on older rows.
      { path: 'userId', matchBy: 'userId', action: 'retain', ...FINANCIAL_RECORD },
      // The admin who made a manual adjustment: attribution, not a party to the transaction.
      { path: 'metadata.actorId', matchBy: 'userId', action: 'anonymize' },
      // The invited friend on a referral reward: attribution, not a party to the transaction.
      { path: 'metadata.referredUserId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  FailedRefund: {
    kind: 'holder',
    references: [
      {
        path: 'ownerId',
        matchBy: 'userId',
        where: { ownerType: 'User' },
        action: 'retain',
        ...FINANCIAL_RECORD,
      },
    ],
  },
  GrantPackage: {
    kind: 'holder',
    references: [{ path: 'createdBy', matchBy: 'userId', action: 'anonymize' }],
  },
  GrantPackageDayCount: { kind: 'noUserData', note: 'Per-package daily redemption counters; aggregate only.' },
  // Unique on (packageId, userId), so it cannot be anonymized in place. The package totals it counted
  // stay, and the credits granted are on the ledger.
  GrantPackageRedemption: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  // A reward not yet paid; once paid it is on the credit ledger.
  HeldCreditReward: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      // The invited friend whose first answer earned the inviter's referral reward.
      { path: 'metadata.referredUserId', matchBy: 'userId', action: 'anonymize' },
    ],
    unmatchedPaths: {
      transactionId: 'Ledger idempotency key embedding the inviter and friend ids; unique and immutable.',
    },
  },
  ModelPrice: {
    kind: 'holder',
    references: [{ path: 'repricedBy', matchBy: 'userId', action: 'anonymize' }],
  },
  PaymentAttempt: {
    kind: 'holder',
    references: [
      {
        path: 'userId',
        matchBy: 'userId',
        action: 'retain',
        reason: PAYMENT_ATTEMPT_REASON,
        retention: expiresAfterTtl('createdAt', 90),
      },
    ],
    secretPaths: ['cardFingerprints'],
  },
  PaymentRiskAction: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'retain', ...FINANCIAL_RECORD }],
  },
  PendingCreditHold: {
    kind: 'holder',
    references: [
      {
        path: 'ownerId',
        matchBy: 'userId',
        where: { ownerType: 'User' },
        action: 'retain',
        reason: CREDIT_HOLD_REASON,
        retention: expiresAfterTtl('settledAt', 7),
      },
      {
        path: 'userId',
        matchBy: 'userId',
        action: 'retain',
        reason: CREDIT_HOLD_REASON,
        retention: expiresAfterTtl('settledAt', 7),
      },
    ],
  },
  ProviderInvoice: {
    kind: 'holder',
    references: [{ path: 'enteredBy', matchBy: 'userId', action: 'anonymize' }],
  },
  ReferralSubscriptionReward: {
    kind: 'holder',
    references: [
      { path: 'payerId', matchBy: 'userId', action: 'retain', ...FINANCIAL_RECORD },
      { path: 'inviterId', matchBy: 'userId', action: 'retain', ...FINANCIAL_RECORD },
    ],
  },
  RevenueSnapshot: {
    kind: 'noUserData',
    note: 'Aggregate MRR figures per day, per plan and per owner type; no row is about one person.',
  },
  // Scopes other than 'User' (platform, org, agent, apiKey, model) are not a person.
  SpendAlert: {
    kind: 'holder',
    references: [
      {
        path: 'scopeId',
        matchBy: 'userId',
        where: { scopeType: 'User' },
        action: 'retain',
        ...FINANCIAL_RECORD,
      },
      { path: 'acknowledgedBy', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  SpendReconciliation: {
    kind: 'noUserData',
    note: 'Monthly provider-versus-internal spend totals; no per-person rows.',
  },
  // A 5-minute spend bucket. Scopes other than 'User' (platform, org, agent, apiKey, model) are not a person.
  SpendRollup: {
    kind: 'holder',
    references: [
      {
        path: 'scopeId',
        matchBy: 'userId',
        where: { scopeType: 'User' },
        action: 'retain',
        reason: SPEND_ROLLUP_REASON,
        retention: expiresAfterTtl('bucketStart', 35),
      },
    ],
  },
  // A Stripe webhook event on the person's subscription: invoices, refunds and disputes.
  BillingEvent: {
    kind: 'holder',
    references: [
      {
        path: 'ownerId',
        matchBy: 'userId',
        where: { ownerType: 'user' },
        action: 'retain',
        ...FINANCIAL_RECORD,
      },
    ],
  },
  // A subscription reconciliation finding. The next reconciliation run writes it again if the
  // subscription still disagrees with Stripe. No `where`: its writers do not agree on the owner type's
  // casing, and an organization id never equals a user id.
  BillingMismatch: {
    kind: 'holder',
    references: [{ path: 'ownerId', matchBy: 'userId', action: 'deleteDocument' }],
    // Which job resolved it ('reconciliation' or 'sync'), not a person.
    unrelatedPaths: ['resolvedBy'],
  },
  StripeDispute: {
    kind: 'holder',
    references: [
      // A dispute against an organization's or an unmatched charge is not a person.
      {
        path: 'subjectId',
        matchBy: 'userId',
        where: { subject: 'user' },
        action: 'retain',
        ...PAYMENT_DISPUTE,
      },
      { path: 'resolution.resolvedBy', matchBy: 'userId', action: 'anonymize' },
      { path: 'contain.undoneBy', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  Subscription: {
    kind: 'holder',
    references: [
      {
        path: 'ownerId',
        matchBy: 'userId',
        where: { ownerType: 'User' },
        action: 'retain',
        ...FINANCIAL_RECORD,
        // Marketing attribution (UTM parameters, referrer) is not part of the billing record.
        alsoRedact: ['acquisition'],
      },
      // The admin who granted a complimentary subscription: attribution on someone else's subscription.
      { path: 'grantedBy', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  UsageEvent: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'retain', ...FINANCIAL_RECORD },
      {
        path: 'ownerId',
        matchBy: 'userId',
        where: { ownerType: 'User' },
        action: 'retain',
        ...FINANCIAL_RECORD,
      },
    ],
  },
  UserLimitEvent: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  UserSubscription: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'retain', ...FINANCIAL_RECORD }],
  },
} satisfies DataHolderRegistry;
