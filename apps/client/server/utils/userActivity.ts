import { Types } from 'mongoose';
import {
  adminAuditLogRepository,
  creditTransactionRepository,
  organizationRepository,
  UserApiKeyAuditLog,
  UserAuthAuditLogModel,
  userRepository,
  type UserAuthAuditEvent,
} from '@bike4mind/database';
import {
  ADMIN_CREDIT_LEDGER_RELIABLE_FROM,
  CreditHolderType,
  USER_CREDIT_HISTORY_DAYS,
  type AdminAuditSeverity,
  type AuditActor,
  type AuditEntry,
  type AuditLogCursor,
  type UserActivityDirection,
  type UserCreditAdjustmentMarker,
  type UserCreditBalancePoint,
  type UserCreditHistory,
} from '@bike4mind/common';
import { adminAuditService } from '@bike4mind/services';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ADJUSTMENT_MARKERS = 200;
const SECURITY_QUERY_MAX_TIME_MS = 15_000;

/** The subject of the Activity view, resolved once by the route. */
export type ActivitySubject = { id: string; name: string; email?: string; isAdmin: boolean };

type ActorDirectory = Map<string, { name: string; email?: string; isAdmin: boolean }>;

// --- Security-store adapters: map UserAuthAuditLog / UserApiKeyAuditLog rows into the AuditEntry shape. ---

export type UserAuthAuditRow = {
  _id: Types.ObjectId;
  userId: string;
  event: UserAuthAuditEvent;
  strategy?: string;
  actorUserId?: string;
  actorIp?: string;
  userAgent?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
};

export type UserApiKeyAuditRow = {
  _id: Types.ObjectId;
  action: 'mint' | 'rotate' | 'revoke';
  keyId: string;
  productId?: string;
  actorUserId: string;
  actorIp?: string;
  actorUserAgent?: string;
  details?: Record<string, unknown>;
  createdAt: Date;
};

const AUTH_EVENT_SEVERITY: Partial<Record<UserAuthAuditEvent, AdminAuditSeverity>> = {
  session_reuse_revoked: 'critical',
  mfa_disabled: 'notice',
  password_reset: 'notice',
  passkey_removed: 'notice',
  oauth_unlink: 'notice',
  session_revoked: 'notice',
  step_up_failed: 'notice',
  refresh_replay_capped: 'notice',
  refresh_recovery_capped: 'notice',
  trusted_device_revoked: 'notice',
  oauth_grant_revoked: 'notice',
  email_change_confirmed: 'notice',
};

const humanize = (value: string): string => {
  const words = value.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const subjectActor = (subject: ActivitySubject): AuditActor => ({
  kind: 'user',
  scope: 'platform',
  userId: subject.id,
  email: subject.email,
  name: subject.name,
  wasAdmin: subject.isAdmin,
});

const resolveActor = (actorUserId: string, subject: ActivitySubject, directory: ActorDirectory): AuditActor => {
  if (actorUserId === subject.id) return subjectActor(subject);
  const known = directory.get(actorUserId);
  return {
    kind: 'user',
    scope: 'platform',
    userId: actorUserId,
    email: known?.email,
    name: known?.name ?? actorUserId,
    wasAdmin: known?.isAdmin ?? false,
  };
};

export const authAuditRowToEntry = (
  row: UserAuthAuditRow,
  subject: ActivitySubject,
  directory: ActorDirectory
): AuditEntry => {
  const actor = resolveActor(row.actorUserId ?? row.userId, subject, directory);
  const byOther = actor.userId !== subject.id;
  const label = humanize(row.event);
  return {
    id: row._id.toString(),
    source: 'auth',
    occurredAt: row.createdAt,
    action: `auth.${row.event}`,
    category: 'identity',
    severity: AUTH_EVENT_SEVERITY[row.event] ?? 'info',
    actor,
    target: { kind: 'user', id: subject.id, displayName: subject.name },
    summary: byOther ? `${actor.name}: ${label} for ${subject.name}` : label,
    details: {
      ...(row.strategy ? { strategy: row.strategy } : {}),
      ...(row.metadata && Object.keys(row.metadata).length > 0
        ? { metadata: adminAuditService.redactAuditPayload(row.metadata) }
        : {}),
    },
    context: {
      ip: row.actorIp,
      userAgent: row.userAgent,
      requestId: row.requestId,
      source: byOther ? 'admin_ui' : 'user',
    },
  };
};

export const apiKeyAuditRowToEntry = (row: UserApiKeyAuditRow, subject: ActivitySubject): AuditEntry => ({
  id: row._id.toString(),
  source: 'apiKey',
  occurredAt: row.createdAt,
  action: `api_key.${row.action}`,
  category: 'access',
  severity: row.action === 'revoke' ? 'notice' : 'info',
  actor: subjectActor(subject),
  target: { kind: 'apiKey', id: row.keyId, displayName: `API key ${row.keyId}` },
  summary: `API key ${row.action === 'mint' ? 'minted' : `${row.action}d`}`,
  details: {
    ...(row.details ? adminAuditService.redactAuditPayload(row.details) : {}),
    ...(row.productId ? { productId: row.productId } : {}),
  },
  context: { ip: row.actorIp, userAgent: row.actorUserAgent, source: 'user' },
});

// --- Merged keyset paging ---

/** Same (occurredAt, _id) keyset as the AdminAuditLog list, on a store keyed by createdAt. */
export const createdAtCursorClauses = (cursor: AuditLogCursor | undefined): Record<string, unknown>[] =>
  cursor
    ? [
        { createdAt: { $lte: cursor.occurredAt } },
        {
          $or: [
            { createdAt: { $lt: cursor.occurredAt } },
            { createdAt: cursor.occurredAt, _id: { $lt: new Types.ObjectId(cursor.id) } },
          ],
        },
      ]
    : [];

const compareNewestFirst = (a: AuditEntry, b: AuditEntry): number => {
  const byTime = b.occurredAt.getTime() - a.occurredAt.getTime();
  if (byTime !== 0) return byTime;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
};

export const buildActorDirectory = async (actorIds: string[]): Promise<ActorDirectory> => {
  const directory: ActorDirectory = new Map();
  await Promise.all(
    [...new Set(actorIds)].map(async id => {
      const actor = await userRepository.findById(id);
      if (actor)
        directory.set(id, {
          name: actor.name || actor.email || id,
          email: actor.email ?? undefined,
          isAdmin: actor.isAdmin,
        });
    })
  );
  return directory;
};

const fetchSecurityEntries = async (
  subject: ActivitySubject,
  page: { limit: number; cursor?: AuditLogCursor }
): Promise<AuditEntry[]> => {
  const cursorClauses = createdAtCursorClauses(page.cursor);
  const [authRows, apiKeyRows] = await Promise.all([
    UserAuthAuditLogModel.find({ $and: [{ userId: subject.id }, ...cursorClauses] })
      .sort({ createdAt: -1, _id: -1 })
      .limit(page.limit + 1)
      .maxTimeMS(SECURITY_QUERY_MAX_TIME_MS)
      .lean<UserAuthAuditRow[]>(),
    UserApiKeyAuditLog.find({ $and: [{ actorUserId: subject.id }, ...cursorClauses] })
      .sort({ createdAt: -1, _id: -1 })
      .limit(page.limit + 1)
      .maxTimeMS(SECURITY_QUERY_MAX_TIME_MS)
      .lean<UserApiKeyAuditRow[]>(),
  ]);

  const otherActorIds = authRows
    .map(row => row.actorUserId)
    .filter((id): id is string => id !== undefined && id !== subject.id);
  const directory = await buildActorDirectory(otherActorIds);

  return [
    ...authRows.map(row => authAuditRowToEntry(row, subject, directory)),
    ...apiKeyRows.map(row => apiKeyAuditRowToEntry(row, subject)),
  ];
};

/**
 * One page of a user's activity. Every source pages on the same global (occurredAt, id) order, so
 * fetching limit + 1 from each and merging yields a correct page whose last row is the next cursor.
 * Security events describe the account itself, so they only join the `target` direction.
 */
export const listUserActivity = async (
  subject: ActivitySubject,
  options: {
    direction: UserActivityDirection;
    includeSecurity: boolean;
    limit: number;
    cursor?: AuditLogCursor;
  }
): Promise<{ entries: AuditEntry[]; nextCursor: AuditLogCursor | null }> => {
  const { direction, includeSecurity, limit, cursor } = options;
  const filters =
    direction === 'target' ? { targetKind: 'user' as const, targetId: subject.id } : { actorUserId: subject.id };

  // A failing security store fails the whole page: a timeline that silently dropped its events
  // would read as "nothing happened", so the admin gets an error and a retry instead.
  const [adminPage, securityEntries] = await Promise.all([
    adminAuditLogRepository.list(filters, { limit, cursor }),
    includeSecurity && direction === 'target' ? fetchSecurityEntries(subject, { limit, cursor }) : Promise.resolve([]),
  ]);
  // adminPage holds at most `limit` rows; its own nextCursor says whether more exist beyond them.
  const merged = [...adminPage.entries, ...securityEntries].sort(compareNewestFirst);
  const entries = merged.slice(0, limit);
  const hasMore = merged.length > limit || adminPage.nextCursor !== null;
  const last = entries[entries.length - 1];
  return { entries, nextCursor: hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null };
};

/** Whether the user is, or ever acted as, an admin: a current flag, an org admin right, or any admin entry as actor. */
export const hasAdminHistory = async (subject: ActivitySubject): Promise<boolean> => {
  if (subject.isAdmin) return true;
  const [adminOrgIds, actedPage] = await Promise.all([
    organizationRepository.findIdsWithAdminRights(subject.id),
    adminAuditLogRepository.list({ actorUserId: subject.id }, { limit: 1 }),
  ]);
  return adminOrgIds.length > 0 || actedPage.entries.length > 0;
};

// --- Credit balance reconstruction ---

const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Walks back from the current balance: the balance at the end of day D is the current balance minus
 * every net delta recorded after D. Returns one point per UTC day, oldest first, ending today.
 */
export const reconstructDailyBalances = (
  currentBalance: number,
  dailyNet: Array<{ day: string; netCredits: number }>,
  now: Date,
  windowDays: number
): UserCreditBalancePoint[] => {
  const netByDay = new Map(dailyNet.map(({ day, netCredits }) => [day, netCredits]));
  const points: UserCreditBalancePoint[] = [];
  let balance = currentBalance;
  for (let offset = 0; offset <= windowDays; offset++) {
    const day = utcDay(new Date(now.getTime() - offset * DAY_MS));
    points.push({ day, balance });
    balance -= netByDay.get(day) ?? 0;
  }
  return points.reverse();
};

const windowStart = (now: Date, windowDays: number): Date => {
  const start = new Date(now.getTime() - windowDays * DAY_MS);
  start.setUTCHours(0, 0, 0, 0);
  return start;
};

/** Null when the window is entirely after the reliable-ledger instant; otherwise the end of the shaded span. */
export const unreliableBoundary = (reliableFrom: string | null, from: Date, now: Date): string | null => {
  if (reliableFrom === null) return now.toISOString();
  const boundary = new Date(reliableFrom);
  if (boundary.getTime() <= from.getTime()) return null;
  return (boundary.getTime() < now.getTime() ? boundary : now).toISOString();
};

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

export const getUserCreditHistory = async (
  user: { id: string; currentCredits: number },
  now: Date = new Date()
): Promise<UserCreditHistory> => {
  const windowDays = USER_CREDIT_HISTORY_DAYS;
  const from = windowStart(now, windowDays);

  const [dailyNet, adjustmentRows] = await Promise.all([
    creditTransactionRepository.dailyNetCreditsForOwner(user.id, CreditHolderType.User, from, now),
    creditTransactionRepository.findAdminAdjustmentsForUser(user.id, from, now, MAX_ADJUSTMENT_MARKERS + 1),
  ]);

  const markerRows = adjustmentRows.slice(0, MAX_ADJUSTMENT_MARKERS);
  const directory = await buildActorDirectory(
    markerRows.map(row => readString(row.metadata?.actorId)).filter((id): id is string => id !== undefined)
  );

  const adjustments: UserCreditAdjustmentMarker[] = markerRows.map(row => {
    const actorUserId = readString(row.metadata?.actorId);
    return {
      transactionId: row.id,
      occurredAt: row.createdAt.toISOString(),
      credits: row.credits,
      actorUserId,
      actorName: actorUserId ? (directory.get(actorUserId)?.name ?? actorUserId) : 'Unknown admin',
      reason: readString(row.metadata?.note),
    };
  });

  return {
    windowDays,
    currentBalance: user.currentCredits,
    points: reconstructDailyBalances(user.currentCredits, dailyNet, now, windowDays),
    adjustments,
    adjustmentsTruncated: adjustmentRows.length > MAX_ADJUSTMENT_MARKERS,
    unreliableBefore: unreliableBoundary(ADMIN_CREDIT_LEDGER_RELIABLE_FROM, from, now),
  };
};
