import type { DataHolderRegistry } from '../types';

const FINANCIAL_RECORD_REASON = 'Financial record kept for accounting and tax obligations (GDPR Art. 17(3)(b))';
const PAYMENT_DISPUTE_REASON =
  'Payment dispute kept to establish and defend a legal claim against the chargeback (GDPR Art. 17(3)(e))';

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
        reason:
          'Abuse-prevention record that stops a repeat signup credit grant (legitimate interest, GDPR Art. 6(1)(f))',
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
        reason: FINANCIAL_RECORD_REASON,
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
        reason: FINANCIAL_RECORD_REASON,
      },
      {
        path: 'recipientId',
        matchBy: 'userId',
        where: { recipientType: 'User' },
        action: 'retain',
        reason: FINANCIAL_RECORD_REASON,
      },
      {
        path: 'senderId',
        matchBy: 'userId',
        where: { senderType: 'User' },
        action: 'retain',
        reason: FINANCIAL_RECORD_REASON,
      },
      // Deprecated alias of ownerId, still present on older rows.
      { path: 'userId', matchBy: 'userId', action: 'retain', reason: FINANCIAL_RECORD_REASON },
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
        reason: FINANCIAL_RECORD_REASON,
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
    references: [{ path: 'userId', matchBy: 'userId', action: 'retain', reason: FINANCIAL_RECORD_REASON }],
    secretPaths: ['cardFingerprints'],
  },
  PaymentRiskAction: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'retain', reason: FINANCIAL_RECORD_REASON }],
  },
  PendingCreditHold: {
    kind: 'holder',
    references: [
      {
        path: 'ownerId',
        matchBy: 'userId',
        where: { ownerType: 'User' },
        action: 'retain',
        reason: FINANCIAL_RECORD_REASON,
      },
      { path: 'userId', matchBy: 'userId', action: 'retain', reason: FINANCIAL_RECORD_REASON },
    ],
  },
  ProviderInvoice: {
    kind: 'holder',
    references: [{ path: 'enteredBy', matchBy: 'userId', action: 'anonymize' }],
  },
  ReferralSubscriptionReward: {
    kind: 'holder',
    references: [
      { path: 'payerId', matchBy: 'userId', action: 'retain', reason: FINANCIAL_RECORD_REASON },
      { path: 'inviterId', matchBy: 'userId', action: 'retain', reason: FINANCIAL_RECORD_REASON },
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
        reason: FINANCIAL_RECORD_REASON,
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
        reason: FINANCIAL_RECORD_REASON,
      },
    ],
  },
  // A dispute against an organization's or an unmatched charge is not a person.
  // A Stripe webhook event on the person's subscription: invoices, refunds and disputes.
  BillingEvent: {
    kind: 'holder',
    references: [
      {
        path: 'ownerId',
        matchBy: 'userId',
        where: { ownerType: 'user' },
        action: 'retain',
        reason: FINANCIAL_RECORD_REASON,
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
      {
        path: 'subjectId',
        matchBy: 'userId',
        where: { subject: 'user' },
        action: 'retain',
        reason: PAYMENT_DISPUTE_REASON,
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
        reason: FINANCIAL_RECORD_REASON,
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
      { path: 'userId', matchBy: 'userId', action: 'retain', reason: FINANCIAL_RECORD_REASON },
      {
        path: 'ownerId',
        matchBy: 'userId',
        where: { ownerType: 'User' },
        action: 'retain',
        reason: FINANCIAL_RECORD_REASON,
      },
    ],
  },
  UserLimitEvent: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  UserSubscription: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'retain', reason: FINANCIAL_RECORD_REASON }],
  },
} satisfies DataHolderRegistry;
