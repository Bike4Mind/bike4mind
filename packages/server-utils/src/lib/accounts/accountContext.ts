import { SIGNUP_RISK_REVIEW_STATES } from '@bike4mind/common';
import { Organization, PaymentAttemptModel, User } from '@bike4mind/database';
import { z } from 'zod';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
export const ACCOUNT_PAYMENT_HISTORY_DAYS = 90;

const nullableAge = z.number().finite().nonnegative().nullable();
const count = z.number().int().nonnegative();

/** Read-only facts for policy consumers; no account's access or review state is changed here. */
export const AccountContextSchema = z.strictObject({
  accountAgeDays: nullableAge,
  responsibleAccountAgeDays: nullableAge,
  emailVerified: z.boolean().nullable(),
  reviewState: z.enum([...SIGNUP_RISK_REVIEW_STATES, 'unknown']),
  riskScore: z.number().finite().min(0).max(100).nullable(),
  reviewReopened: z.boolean().nullable(),
  paymentRiskEvent: z.boolean().nullable(),
  hasCreditPurchase: z.boolean().nullable(),
  lastCreditPurchaseAgeDays: nullableAge,
  payments: z.strictObject({
    status: z.enum(['observed', 'missing']),
    succeeded: count,
    failed: count,
    radarBlocked: count,
    elevatedRisk: count,
    latestSucceededAgeDays: nullableAge,
  }),
  evidence: z.strictObject({ status: z.enum(['observed', 'missing']), ageHours: nullableAge }),
});
export type AccountContext = z.infer<typeof AccountContextSchema>;

export type AccountContextAccount = { ownerType: 'User' | 'Organization'; ownerId: string };

export type AccountContextUser = {
  id: string;
  createdAt?: Date | null;
  emailVerified?: boolean;
  riskScore?: { score: number; reviewState: (typeof SIGNUP_RISK_REVIEW_STATES)[number] } | null;
  riskReviewReopenedAt?: Date | null;
  paymentRiskEventAt?: Date | null;
  lastCreditsPurchasedAt?: Date | null;
  riskEvidence?: { summary?: { computedAt: Date } | null } | null;
};

export type AccountContextOrganization = {
  id: string;
  userId: string;
  createdAt?: Date | null;
  lastCreditsPurchasedAt?: Date | null;
};

export type AccountPaymentHistory = {
  userId: string;
  succeeded: number;
  failed: number;
  radarBlocked: number;
  elevatedRisk: number;
  latestSucceededAt: Date | null;
};

export type AccountContextDeps = {
  findUsers: (ids: readonly string[]) => Promise<readonly AccountContextUser[]>;
  findOrganizations: (ids: readonly string[]) => Promise<readonly AccountContextOrganization[]>;
  findPaymentHistory: (
    userIds: readonly string[],
    since: Date,
    until: Date
  ) => Promise<readonly AccountPaymentHistory[]>;
};

const unique = (values: readonly string[]): string[] => [...new Set(values)];

function ageAt(date: Date | null | undefined, now: Date, unitMs: number): number | null {
  if (!date) return null;
  const elapsed = now.getTime() - date.getTime();
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed / unitMs : null;
}

function buildContext(
  account: AccountContextAccount,
  organization: AccountContextOrganization | undefined,
  user: AccountContextUser | undefined,
  payment: AccountPaymentHistory | undefined,
  now: Date
): AccountContext {
  const owner = account.ownerType === 'User' ? user : organization;
  const evidenceAge = ageAt(user?.riskEvidence?.summary?.computedAt, now, HOUR_MS);
  return AccountContextSchema.parse({
    accountAgeDays: ageAt(owner?.createdAt, now, DAY_MS),
    responsibleAccountAgeDays: ageAt(user?.createdAt, now, DAY_MS),
    emailVerified: user?.emailVerified ?? null,
    reviewState: user?.riskScore?.reviewState ?? 'unknown',
    riskScore: user?.riskScore?.score ?? null,
    reviewReopened: user ? Boolean(user.riskReviewReopenedAt) : null,
    paymentRiskEvent: user ? Boolean(user.paymentRiskEventAt) : null,
    hasCreditPurchase: owner ? Boolean(owner.lastCreditsPurchasedAt) : null,
    lastCreditPurchaseAgeDays: ageAt(owner?.lastCreditsPurchasedAt, now, DAY_MS),
    // Retention and older payment integrations mean no rows cannot establish clean payment history.
    payments: {
      status: payment ? 'observed' : 'missing',
      succeeded: payment?.succeeded ?? 0,
      failed: payment?.failed ?? 0,
      radarBlocked: payment?.radarBlocked ?? 0,
      elevatedRisk: payment?.elevatedRisk ?? 0,
      latestSucceededAgeDays: ageAt(payment?.latestSucceededAt, now, DAY_MS),
    },
    evidence: { status: evidenceAge === null ? 'missing' : 'observed', ageHours: evidenceAge },
  });
}

/** Organizations use their billing owner's risk facts, never those of a member or key creator. */
export async function resolveAccountContexts(
  accounts: readonly AccountContextAccount[],
  now: Date,
  deps: AccountContextDeps
): Promise<Map<string, AccountContext>> {
  if (accounts.length === 0) return new Map();
  z.date().parse(now);
  const organizationIds = unique(accounts.filter(account => account.ownerType === 'Organization').map(a => a.ownerId));
  const organizations = organizationIds.length > 0 ? await deps.findOrganizations(organizationIds) : [];
  const organizationById = new Map(organizations.map(organization => [organization.id, organization]));
  const userIds = unique([
    ...accounts.filter(account => account.ownerType === 'User').map(account => account.ownerId),
    ...organizations.map(organization => organization.userId),
  ]);
  const [users, payments] =
    userIds.length > 0
      ? await Promise.all([
          deps.findUsers(userIds),
          deps.findPaymentHistory(userIds, new Date(now.getTime() - ACCOUNT_PAYMENT_HISTORY_DAYS * DAY_MS), now),
        ])
      : [[], []];
  const userById = new Map(users.map(user => [user.id, user]));
  const paymentByUserId = new Map(payments.map(payment => [payment.userId, payment]));
  return new Map(
    accounts.map(account => {
      const organization = organizationById.get(account.ownerId);
      const userId = account.ownerType === 'User' ? account.ownerId : organization?.userId;
      return [
        `${account.ownerType}:${account.ownerId}`,
        buildContext(
          account,
          organization,
          userId ? userById.get(userId) : undefined,
          userId ? paymentByUserId.get(userId) : undefined,
          now
        ),
      ];
    })
  );
}

const validObjectIds = (ids: readonly string[]): string[] => ids.filter(id => /^[0-9a-f]{24}$/i.test(id));

export function defaultAccountContextDeps(): AccountContextDeps {
  return {
    findUsers: async ids => {
      const validIds = validObjectIds(ids);
      if (validIds.length === 0) return [];
      const rows = await User.find({ _id: { $in: validIds } })
        .select(
          'createdAt emailVerified riskScore.score riskScore.reviewState riskReviewReopenedAt paymentRiskEventAt lastCreditsPurchasedAt riskEvidence.summary.computedAt'
        )
        .lean<(Omit<AccountContextUser, 'id'> & { _id: unknown })[]>();
      return rows.map(row => ({ ...row, id: String(row._id) }));
    },
    findOrganizations: async ids => {
      const validIds = validObjectIds(ids);
      if (validIds.length === 0) return [];
      const rows = await Organization.find({ _id: { $in: validIds } })
        .select('userId createdAt lastCreditsPurchasedAt')
        .lean<(Omit<AccountContextOrganization, 'id'> & { _id: unknown })[]>();
      return rows.map(row => ({ ...row, id: String(row._id) }));
    },
    findPaymentHistory: async (userIds, since, until) => {
      if (userIds.length === 0) return [];
      const rows = await PaymentAttemptModel.aggregate<Omit<AccountPaymentHistory, 'userId'> & { _id: string }>([
        // A recordCheckoutStart row is visit-only; its real attempt arrives later under the payment intent id.
        {
          $match: {
            userId: { $in: [...userIds] },
            createdAt: { $gte: since, $lte: until },
            paymentIntentId: { $not: /^cs_/ },
          },
        },
        {
          $group: {
            _id: '$userId',
            succeeded: { $sum: { $cond: [{ $eq: ['$outcome', 'succeeded'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$outcome', 'failed'] }, 1, 0] } },
            radarBlocked: { $sum: { $cond: [{ $eq: ['$radarBlocked', true] }, 1, 0] } },
            elevatedRisk: { $sum: { $cond: [{ $in: ['$riskLevel', ['elevated', 'highest']] }, 1, 0] } },
            latestSucceededAt: { $max: { $cond: [{ $eq: ['$outcome', 'succeeded'] }, '$createdAt', null] } },
          },
        },
      ]).option({ maxTimeMS: 2000 });
      return rows.map(({ _id, ...row }) => ({ ...row, userId: _id }));
    },
  };
}
