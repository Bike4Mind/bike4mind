import type { DataHolderRegistry } from '../types';

const FINANCIAL_RECORD_REASON = 'Financial record kept for accounting and tax obligations (GDPR Art. 17(3)(b))';

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
    // The claim stays keyed by `identityDigest`, which is what blocks a repeat grant; the link back to
    // the person is not needed for that.
    references: [{ path: 'ownerId', matchBy: 'userId', action: 'anonymize' }],
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
  UserSubscription: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'retain', reason: FINANCIAL_RECORD_REASON }],
  },
} satisfies DataHolderRegistry;
