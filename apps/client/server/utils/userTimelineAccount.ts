import { Types } from 'mongoose';
import type { AuditLogCursor, ISignupMeta, UserTimelineEntry } from '@bike4mind/common';
import {
  AuthEventModel,
  disposableDomainRepository,
  ImageModerationIncident,
  PaymentAttemptModel,
  signupProtectionRepository,
  UserAuthAuditLogModel,
} from '@bike4mind/database';

const QUERY_MAX_TIME_MS = 15_000;

/** The account fields the timeline reads beyond the audit subject. */
export type TimelineAccount = {
  createdAt: Date;
  currentCredits: number;
  email?: string;
  signupMeta?: ISignupMeta | null;
  signupGrantHeldReason?: string | null;
};

export type TimelineWindow = { cursor?: AuditLogCursor; range: { from?: Date; to?: Date } };

export const emailDomainOf = (email: string | undefined): string | undefined => {
  const at = email?.lastIndexOf('@') ?? -1;
  return email && at > 0
    ? email
        .slice(at + 1)
        .trim()
        .toLowerCase() || undefined
    : undefined;
};

/** Whether (at, id) is inside the range and strictly older than the cursor. */
export const isInWindow = (at: Date, id: string, { cursor, range }: TimelineWindow): boolean => {
  if (range.from && at < range.from) return false;
  if (range.to && at > range.to) return false;
  if (!cursor) return true;
  const byTime = at.getTime() - cursor.occurredAt.getTime();
  return byTime < 0 || (byTime === 0 && id < cursor.id);
};

const SIGNUP_HOLD_LABELS: Readonly<Record<string, string>> = {
  budget_exhausted: 'Signup credits held: budget',
  risk_review: 'Signup credits held: risk review',
};

/** The one "Signed up" row, built from the account itself so it outlives the 90-day network rows. */
export const fetchSignupEntries = async (
  userId: string,
  account: TimelineAccount,
  window: TimelineWindow
): Promise<{ entries: UserTimelineEntry[]; hasMore: boolean }> => {
  if (!isInWindow(account.createdAt, userId, window)) return { entries: [], hasMore: false };

  const domain = emailDomainOf(account.email);
  const [review, disposableSources] = domain
    ? await Promise.all([
        signupProtectionRepository.findReview(domain),
        disposableDomainRepository.disposableSources([domain]),
      ])
    : [null, []];
  const meta = account.signupMeta;

  const flags = [
    disposableSources.length > 0 ? 'Disposable domain' : undefined,
    review?.status === 'held_pending_review' ? 'Domain held' : undefined,
    review?.status === 'blocked' ? 'Domain blocked' : undefined,
    meta?.isDatacenter ? 'Datacenter IP' : undefined,
    meta?.wafAnonIp ? 'Anonymous IP' : undefined,
    account.signupGrantHeldReason ? SIGNUP_HOLD_LABELS[account.signupGrantHeldReason] : undefined,
  ].filter((flag): flag is string => flag !== undefined);

  const detail = [
    meta?.ip ?? undefined,
    meta?.country ?? undefined,
    meta?.asn ? `AS${meta.asn}${meta.asnOrg ? ` ${meta.asnOrg}` : ''}` : undefined,
    domain ? `@${domain}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    entries: [
      {
        type: 'signup',
        id: userId,
        at: account.createdAt,
        summary: 'Signed up',
        detail: detail || undefined,
        flags: flags.length > 0 ? flags : undefined,
        alert: flags.some(flag => flag !== 'Datacenter IP') || undefined,
      },
    ],
    hasMore: false,
  };
};

const createdAtWindowClauses = ({ cursor, range }: TimelineWindow): Record<string, unknown>[] => [
  ...(range.from ? [{ createdAt: { $gte: range.from } }] : []),
  ...(range.to ? [{ createdAt: { $lte: range.to } }] : []),
  ...(cursor
    ? [
        {
          $or: [
            { createdAt: { $lt: cursor.occurredAt } },
            { createdAt: cursor.occurredAt, _id: { $lt: new Types.ObjectId(cursor.id) } },
          ],
        },
      ]
    : []),
];

type PaymentAttemptRow = {
  _id: Types.ObjectId;
  kind: string;
  amount: number | null;
  currency: string | null;
  outcome: string;
  riskLevel: string | null;
  radarBlocked: boolean;
  hostingNetwork: boolean | null;
  createdAt: Date;
};

const formatMoney = (amount: number | null, currency: string | null): string | undefined =>
  amount === null
    ? undefined
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format(
        amount / 100
      );

/**
 * Failed and fraud-blocked charges. Successful ones are already the credit rows' purchases, and a
 * "started" attempt on its own is noise.
 */
export const fetchPaymentEntries = async (userId: string, limit: number, window: TimelineWindow) => {
  const rows = await PaymentAttemptModel.find({
    $and: [{ userId }, { $or: [{ outcome: 'failed' }, { radarBlocked: true }] }, ...createdAtWindowClauses(window)],
  })
    .select('_id kind amount currency outcome riskLevel radarBlocked hostingNetwork createdAt')
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<PaymentAttemptRow[]>();
  return {
    entries: rows.slice(0, limit).map((row): UserTimelineEntry => ({
      type: 'payment',
      id: row._id.toHexString(),
      at: row.createdAt,
      outcome: row.outcome,
      summary: `${row.radarBlocked ? 'Charge blocked by fraud screening' : 'Charge failed'}${
        formatMoney(row.amount, row.currency) ? `: ${formatMoney(row.amount, row.currency)}` : ''
      }`,
      detail:
        [row.kind === 'subscription' ? 'Subscription' : 'Credits', row.riskLevel ? `risk ${row.riskLevel}` : undefined]
          .filter(Boolean)
          .join(' · ') || undefined,
      flags: row.hostingNetwork ? ['Hosting network'] : undefined,
      alert: true,
    })),
    hasMore: rows.length > limit,
  };
};

type ModerationRow = {
  _id: Types.ObjectId;
  model: string;
  surface?: string;
  labels?: Array<{ name: string }>;
  reviewStatus?: string;
  createdAt: Date;
};

export const fetchModerationEntries = async (userId: string, limit: number, window: TimelineWindow) => {
  const rows = await ImageModerationIncident.find({ $and: [{ userId }, ...createdAtWindowClauses(window)] })
    .select('_id model surface labels reviewStatus createdAt')
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<ModerationRow[]>();
  return {
    entries: rows.slice(0, limit).map((row): UserTimelineEntry => {
      const labels = [...new Set((row.labels ?? []).map(label => label.name))].slice(0, 3);
      return {
        type: 'moderation',
        id: row._id.toHexString(),
        at: row.createdAt,
        reviewStatus: row.reviewStatus,
        summary: `Image flagged by moderation${labels.length > 0 ? `: ${labels.join(', ')}` : ''}`,
        detail:
          [row.model, row.surface, `review ${row.reviewStatus ?? 'pending'}`].filter(Boolean).join(' · ') || undefined,
        alert: row.reviewStatus !== 'false_positive' || undefined,
      };
    }),
    hasMore: rows.length > limit,
  };
};

/** Where a sign-in came from, and whether its IP or country is new for this account. */
export type SignInNetwork = { country?: string; newIp: boolean; newCountry: boolean };

// A login's network row is written alongside its audit row; anything further apart is another login.
const MATCH_WINDOW_MS = 2 * 60 * 1000;

/**
 * Countries come from the login network rows (90-day retention), so older sign-ins show none. An
 * IP is new on its first successful login unless it is the signup IP; a country likewise.
 */
export const loadSignInNetworks = async (
  userId: string,
  rows: ReadonlyArray<{ _id: Types.ObjectId; event: string; actorIp?: string; createdAt: Date }>,
  signupMeta: ISignupMeta | null | undefined
): Promise<Map<string, SignInNetwork>> => {
  const logins = rows.filter(row => row.event === 'login_success' && row.actorIp);
  const networks = new Map<string, SignInNetwork>();
  if (logins.length === 0) return networks;
  const ips = [...new Set(logins.map(row => row.actorIp as string))];

  const [firstByIp, authEvents] = await Promise.all([
    UserAuthAuditLogModel.aggregate<{ _id: string; first: Date }>([
      { $match: { userId, event: 'login_success', actorIp: { $in: ips } } },
      { $group: { _id: '$actorIp', first: { $min: '$createdAt' } } },
    ]).option({ maxTimeMS: QUERY_MAX_TIME_MS }),
    AuthEventModel.find({ userId })
      .select('ip country createdAt')
      .sort({ createdAt: 1 })
      .limit(1000)
      .maxTimeMS(QUERY_MAX_TIME_MS)
      .lean<Array<{ ip: string | null; country: string | null; createdAt: Date }>>(),
  ]);
  const firstSeenIp = new Map(firstByIp.map(row => [row._id, row.first.getTime()]));
  const firstSeenCountry = new Map<string, number>();
  for (const event of authEvents) {
    if (event.country && !firstSeenCountry.has(event.country))
      firstSeenCountry.set(event.country, event.createdAt.getTime());
  }

  for (const row of logins) {
    const ip = row.actorIp as string;
    const at = row.createdAt.getTime();
    const match = authEvents.find(
      event => event.ip === ip && Math.abs(event.createdAt.getTime() - at) <= MATCH_WINDOW_MS
    );
    const country = match?.country ?? undefined;
    const countryFirst = country ? firstSeenCountry.get(country) : undefined;
    networks.set(row._id.toHexString(), {
      country,
      newIp: ip !== signupMeta?.ip && firstSeenIp.get(ip) === at,
      newCountry:
        country !== undefined &&
        country !== signupMeta?.country &&
        countryFirst !== undefined &&
        Math.abs(countryFirst - at) <= MATCH_WINDOW_MS,
    });
  }
  return networks;
};
