import { Types } from 'mongoose';
import {
  adminAuditLogRepository,
  CREDIT_BALANCE_EVENT_TYPES,
  CreditTransaction,
  Session,
  UserApiKeyAuditLog,
  UserAuthAuditLogModel,
} from '@bike4mind/database';
import {
  authMethodLabel,
  CreditHolderType,
  type AuditLogCursor,
  type SessionOriginChannel,
  type UserTimelineEntry,
  type UserTimelineType,
} from '@bike4mind/common';
import {
  apiKeyAuditRowToEntry,
  authAuditRowToEntry,
  buildActorDirectory,
  createdAtCursorClauses,
  type ActivitySubject,
  type UserApiKeyAuditRow,
  type UserAuthAuditRow,
} from './userActivity';
import { authEventSummary } from './userSignIns';

const QUERY_MAX_TIME_MS = 15_000;

export type TimelineRange = { from?: Date; to?: Date };

type TimelinePageOptions = { limit: number; cursor?: AuditLogCursor; range: TimelineRange };

/** One source's slice: its newest rows after the cursor, and whether it holds more beyond them. */
type SourcePage = { entries: UserTimelineEntry[]; hasMore: boolean };

const createdAtRangeClauses = ({ from, to }: TimelineRange): Record<string, unknown>[] => [
  ...(from ? [{ createdAt: { $gte: from } }] : []),
  ...(to ? [{ createdAt: { $lte: to } }] : []),
];

const fetchedPage = <Row>(rows: Row[], limit: number, toEntry: (row: Row) => UserTimelineEntry): SourcePage => ({
  entries: rows.map(toEntry),
  hasMore: rows.length > limit,
});

// --- Sources ---

const fetchAdminEntries = async (subject: ActivitySubject, page: TimelinePageOptions): Promise<SourcePage> => {
  const { entries, nextCursor } = await adminAuditLogRepository.list(
    {
      targetKind: 'user',
      targetId: subject.id,
      from: page.range.from?.toISOString(),
      to: page.range.to?.toISOString(),
    },
    { limit: page.limit, cursor: page.cursor }
  );
  return {
    entries: entries.map(audit => ({
      type: 'admin',
      id: audit.id,
      at: audit.occurredAt,
      summary: audit.summary,
      audit,
    })),
    hasMore: nextCursor !== null,
  };
};

const fetchSignInEntries = async (subject: ActivitySubject, page: TimelinePageOptions): Promise<SourcePage> => {
  const rows = await UserAuthAuditLogModel.find({
    $and: [{ userId: subject.id }, ...createdAtRangeClauses(page.range), ...createdAtCursorClauses(page.cursor)],
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(page.limit + 1)
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<UserAuthAuditRow[]>();
  const directory = await buildActorDirectory(
    rows.map(row => row.actorUserId).filter((id): id is string => id !== undefined && id !== subject.id)
  );
  return fetchedPage(rows, page.limit, row => ({
    type: 'signin',
    id: row._id.toString(),
    at: row.createdAt,
    summary: authEventSummary(row.event, authMethodLabel(row.strategy)),
    detail: row.actorIp,
    audit: authAuditRowToEntry(row, subject, directory),
  }));
};

const API_KEY_VERBS: Readonly<Record<UserApiKeyAuditRow['action'], string>> = {
  mint: 'Created',
  rotate: 'Rotated',
  revoke: 'Revoked',
};

const readName = (details: Record<string, unknown> | undefined): string | undefined =>
  typeof details?.name === 'string' && details.name.trim() !== '' ? details.name : undefined;

const fetchKeyEntries = async (subject: ActivitySubject, page: TimelinePageOptions): Promise<SourcePage> => {
  const rows = await UserApiKeyAuditLog.find({
    $and: [{ actorUserId: subject.id }, ...createdAtRangeClauses(page.range), ...createdAtCursorClauses(page.cursor)],
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(page.limit + 1)
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<UserApiKeyAuditRow[]>();
  return fetchedPage(rows, page.limit, row => ({
    type: 'key',
    id: row._id.toString(),
    at: row.createdAt,
    summary: `${API_KEY_VERBS[row.action]} API key ${readName(row.details) ?? row.keyId}`,
    detail: row.actorIp,
    audit: apiKeyAuditRowToEntry(row, subject),
  }));
};

type CreditRow = {
  _id: Types.ObjectId;
  type: (typeof CREDIT_BALANCE_EVENT_TYPES)[number];
  credits: number;
  description?: string;
  status?: string;
  createdAt: Date;
};

const CREDIT_SUMMARIES: Readonly<Record<CreditRow['type'], string>> = {
  purchase: 'Bought credits',
  subscription: 'Subscription credits renewed',
  generic_add: 'Credits added',
  generic_deduct: 'Credits removed',
  transfer_credit: 'Transferred credits',
  received_credit: 'Received credits',
};

const formatSignedCredits = (credits: number): string =>
  `${credits > 0 ? '+' : credits < 0 ? '-' : ''}${Math.abs(credits).toLocaleString('en-US')} credits`;

/**
 * Balance moves other than usage. Admin adjustments are left to the admin source, which carries the
 * actor and reason; listing them here too would show each one twice.
 */
export const creditEventsFilter = (userId: string, page: Pick<TimelinePageOptions, 'cursor' | 'range'>) => ({
  $and: [
    // Must repeat the partial filter of credit_tx_owner_balance_events for the planner to use it.
    { ownerId: userId, ownerType: CreditHolderType.User, type: { $in: [...CREDIT_BALANCE_EVENT_TYPES] } },
    { reason: { $ne: 'admin_adjustment' } },
    ...createdAtRangeClauses(page.range),
    ...createdAtCursorClauses(page.cursor),
  ],
});

const fetchCreditEntries = async (subject: ActivitySubject, page: TimelinePageOptions): Promise<SourcePage> => {
  const rows = await CreditTransaction.find(creditEventsFilter(subject.id, page))
    .sort({ createdAt: -1, _id: -1 })
    .limit(page.limit + 1)
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<CreditRow[]>();
  return fetchedPage(rows, page.limit, row => ({
    type: 'credit',
    id: row._id.toString(),
    at: row.createdAt,
    summary: `${CREDIT_SUMMARIES[row.type]}: ${formatSignedCredits(row.credits)}`,
    detail: [row.description, row.status && row.status !== 'completed' ? `Payment ${row.status}` : undefined]
      .filter(Boolean)
      .join(' \u00b7 '),
    credits: row.credits,
    transactionType: row.type,
  }));
};

/**
 * Notebooks page on `_id` (the `{ deletedAt, userId, _id }` index), so their time is the ObjectId's
 * own second-precision timestamp. These clauses express "(at, id) < cursor" and the date range in
 * that _id order, which matches the merged (at, id) order exactly.
 */
export const notebookIdClauses = (cursor: AuditLogCursor | undefined, range: TimelineRange) => {
  const clauses: Record<string, unknown>[] = [];
  const idAtSecond = (seconds: number) => Types.ObjectId.createFromTime(seconds);
  if (range.from) clauses.push({ _id: { $gte: idAtSecond(Math.ceil(range.from.getTime() / 1000)) } });
  if (range.to) clauses.push({ _id: { $lt: idAtSecond(Math.floor(range.to.getTime() / 1000) + 1) } });
  if (cursor) {
    const ms = cursor.occurredAt.getTime();
    const earlier = { _id: { $lt: idAtSecond(Math.ceil(ms / 1000)) } };
    // Only a cursor on a whole second can tie with a notebook's time; then the id breaks the tie. The
    // cursor id may come from another source and sit in a later second, so cap the tie at this second.
    let tied: Record<string, unknown> | undefined;
    if (ms % 1000 === 0) {
      const secondEnd = idAtSecond(ms / 1000 + 1);
      const cursorId = new Types.ObjectId(cursor.id);
      tied = {
        _id: {
          $gte: idAtSecond(ms / 1000),
          $lt: cursorId.toHexString() < secondEnd.toHexString() ? cursorId : secondEnd,
        },
      };
    }
    clauses.push(tied ? { $or: [earlier, tied] } : earlier);
  }
  return clauses;
};

type NotebookRow = { _id: Types.ObjectId; name?: string; origin?: { channel?: SessionOriginChannel } };

const CHANNEL_LABELS: Readonly<Record<SessionOriginChannel, string>> = {
  web: 'Web app',
  api: 'API',
  slack: 'Slack',
  cli: 'CLI',
  agent: 'Agent',
};

const notebookSummary = (row: NotebookRow): string => {
  const name = row.name?.trim() || 'Untitled';
  return row.origin?.channel === 'agent' ? `Agent run started "${name}"` : `Started notebook "${name}"`;
};

const fetchUsageEntries = async (subject: ActivitySubject, page: TimelinePageOptions): Promise<SourcePage> => {
  const rows = await Session.find({ $and: [{ userId: subject.id }, ...notebookIdClauses(page.cursor, page.range)] })
    .select('_id name origin')
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<NotebookRow[]>();
  return fetchedPage(rows, page.limit, row => ({
    type: 'usage',
    id: row._id.toString(),
    at: row._id.getTimestamp(),
    summary: notebookSummary(row),
    detail: row.origin?.channel ? `Via ${CHANNEL_LABELS[row.origin.channel]}` : undefined,
    notebookId: row._id.toString(),
  }));
};

const SOURCES: Readonly<
  Record<UserTimelineType, (subject: ActivitySubject, page: TimelinePageOptions) => Promise<SourcePage>>
> = {
  signin: fetchSignInEntries,
  usage: fetchUsageEntries,
  credit: fetchCreditEntries,
  key: fetchKeyEntries,
  admin: fetchAdminEntries,
};

// --- Merge ---

export const compareTimelineNewestFirst = (a: UserTimelineEntry, b: UserTimelineEntry): number => {
  const byTime = b.at.getTime() - a.at.getTime();
  if (byTime !== 0) return byTime;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
};

/**
 * Merges source pages into one. Each source returned its newest rows after the same cursor, so the
 * first `limit` merged rows are globally correct and the last of them is the next cursor.
 */
export const mergeTimelinePages = (
  pages: SourcePage[],
  limit: number
): { entries: UserTimelineEntry[]; nextCursor: AuditLogCursor | null } => {
  const merged = pages.flatMap(page => page.entries).sort(compareTimelineNewestFirst);
  const entries = merged.slice(0, limit);
  const hasMore = merged.length > limit || pages.some(page => page.hasMore);
  const last = entries[entries.length - 1];
  return { entries, nextCursor: hasMore && last ? { occurredAt: last.at, id: last.id } : null };
};

/**
 * One page of a user's unified timeline. Every source is queried with the same keyset bound and at
 * most limit + 1 rows, so a page costs one bounded indexed read per selected source.
 * A failing source fails the page: a timeline that silently dropped one would read as "nothing happened".
 */
export const listUserTimeline = async (
  subject: ActivitySubject,
  options: { types: readonly UserTimelineType[]; limit: number; cursor?: AuditLogCursor; range: TimelineRange }
) => {
  const { types, ...page } = options;
  const pages = await Promise.all(types.map(type => SOURCES[type](subject, page)));
  return mergeTimelinePages(pages, page.limit);
};
