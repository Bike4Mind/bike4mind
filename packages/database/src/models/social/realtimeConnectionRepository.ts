import {
  ApiKeyStatus,
  isAuthSessionActive,
  type EndRealtimeConnectionsResult,
  type IRealtimeConnectionRepository,
  type RealtimeConnectionFilter,
  type UserModerationStatus,
} from '@bike4mind/common';
import { isValidObjectId, type FilterQuery } from 'mongoose';
import { AuthSessionModel } from '../auth/AuthSessionModel';
import { UserApiKey } from '../auth/UserApiKeyModel';
import User from '../auth/UserModel';
import { Connection } from './ConnectionModel';
import { QuerySubscription } from './QuerySubscriptionModel';

const ID_CHUNK_SIZE = 500;

/** API Gateway closes every WebSocket after 2 hours, whatever the credential behind it. */
export const REALTIME_CONNECTION_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;

export type RealtimeSweepReason =
  | 'expired'
  | 'userMissing'
  | 'accountBlocked'
  | 'tokenVersionStale'
  | 'sessionRevoked'
  | 'apiKeyRevoked'
  // Already ended by a revoke path; the sweep still owes the socket close.
  | 'ended'
  // Ended longer ago than any socket can live; the row is deleted without a close.
  | 'endedLapsed';

export interface RealtimeSweepTarget {
  connectionId: string;
  reason: RealtimeSweepReason;
}

/** The user fields the sweep's account-state predicate reads (see userService.accountBlockReasons). */
export interface RealtimeSweepUserState {
  isBanned?: boolean | null;
  disputePending?: boolean | null;
  moderation?: { status?: UserModerationStatus | null } | null;
}

function chunk<T>(items: readonly T[], size = ID_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`realtimeConnectionRepository: ${name} must be a non-empty string`);
  }
}

/**
 * Turn a filter into a Connection query. Every discriminant is asserted first: an undefined or
 * empty value would otherwise be dropped by Mongoose's query casting and widen the match to a much
 * larger set of connections.
 */
function toConnectionQuery(filter: RealtimeConnectionFilter): FilterQuery<unknown> {
  if ('connectionIds' in filter) {
    if (!Array.isArray(filter.connectionIds) || filter.connectionIds.length === 0) {
      throw new TypeError('realtimeConnectionRepository: connectionIds must be a non-empty array');
    }
    filter.connectionIds.forEach(id => assertNonEmptyString('connectionIds entry', id));
    return { connectionId: { $in: filter.connectionIds } };
  }
  if ('sid' in filter) {
    assertNonEmptyString('sid', filter.sid);
    return { sid: filter.sid };
  }
  if ('apiKeyId' in filter) {
    assertNonEmptyString('apiKeyId', filter.apiKeyId);
    return { apiKeyId: filter.apiKeyId };
  }
  assertNonEmptyString('userId', filter.userId);
  if ('exceptSid' in filter) assertNonEmptyString('exceptSid', filter.exceptSid);
  return {
    userId: filter.userId,
    // A row without a sid (opened before sids were recorded) may be the caller's own tab, so
    // "every session except this one" must not match it.
    ...('exceptSid' in filter && { sid: { $exists: true, $ne: filter.exceptSid } }),
    ...(filter.sessionsOnly && { apiKeyId: { $exists: false } }),
  };
}

/**
 * Remove these connections from every QuerySubscription and delete any doc left with no
 * subscribers. The delete re-checks emptiness in its own filter, so a subscriber added between
 * the $pull and the delete keeps its doc.
 */
async function pullSubscribers(connectionIds: readonly string[]): Promise<void> {
  for (const ids of chunk(connectionIds)) {
    const affected = await QuerySubscription.find({ 'subscribers.connectionId': { $in: ids } }, { _id: 1 }).lean();
    if (affected.length === 0) continue;
    const affectedIds = affected.map(doc => doc._id);
    await QuerySubscription.updateMany(
      { _id: { $in: affectedIds } },
      { $pull: { subscribers: { connectionId: { $in: ids } } } }
    );
    await QuerySubscription.deleteMany({ _id: { $in: affectedIds }, subscribers: { $size: 0 } });
  }
}

/**
 * Pull the connections' subscribers and mark their rows ended (kept, not deleted, so the sweep can
 * still close the sockets). Only live rows are looked up by userId/sid/apiKeyId filters; an
 * explicit connectionIds filter is trusted as given.
 */
async function endConnections(filter: RealtimeConnectionFilter): Promise<EndRealtimeConnectionsResult> {
  const query = toConnectionQuery(filter);
  const connectionIds =
    'connectionIds' in filter
      ? [...new Set(filter.connectionIds)]
      : ((await Connection.find(query).distinct('connectionId')) as string[]);
  if (connectionIds.length === 0) return { connectionIds: [] };

  // Subscribers first: a crash in between leaves a live row the sweep still finds, never a
  // subscriber entry whose row is already gone.
  await pullSubscribers(connectionIds);
  const endedAt = new Date();
  for (const ids of chunk(connectionIds)) {
    await Connection.updateMany({ connectionId: { $in: ids }, endedAt: { $exists: false } }, { $set: { endedAt } });
  }
  return { connectionIds };
}

/**
 * Delete rows that were ended, once their socket is confirmed closed (or gone). Never touches a
 * live row.
 */
async function deleteEndedConnections(connectionIds: readonly string[]): Promise<number> {
  let deleted = 0;
  for (const ids of chunk(connectionIds)) {
    const result = await Connection.deleteMany({ connectionId: { $in: ids }, endedAt: { $exists: true } });
    deleted += result.deletedCount;
  }
  return deleted;
}

/**
 * Re-stamp a connection with a freshly verified access token and drop all its subscriptions, so
 * the client re-subscribes under the new token (and the ACL scope is re-evaluated). Returns false
 * when the row is gone or already ended: an ended connection is never revived.
 */
async function reauthenticate(
  connectionId: string,
  auth: { tokenVersion: number; authExpiresAt: Date; sid?: string }
): Promise<boolean> {
  const result = await Connection.updateOne(
    { connectionId, endedAt: { $exists: false } },
    { $set: { ...auth, reauthAt: new Date() } }
  );
  if (result.matchedCount === 0) return false;
  await pullSubscribers([connectionId]);
  return true;
}

interface SweepRow {
  authExpiresAt?: Date | null;
  createdAt?: Date | null;
  tokenVersion?: number | null;
  sid?: string | null;
  apiKeyId?: string | null;
}

function sweepReason(
  row: SweepRow,
  ctx: {
    now: Date;
    expiredBefore: Date;
    legacyCreatedBefore: Date;
    isAccountBlocked: (user: RealtimeSweepUserState) => boolean;
    user?: RealtimeSweepUserState & { tokenVersion?: number | null };
    session?: { revokedAt?: Date | null; expiresAt: Date };
    apiKey?: { status?: string | null; expiresAt?: Date | null };
  }
): RealtimeSweepReason | null {
  const expired = row.authExpiresAt
    ? row.authExpiresAt < ctx.expiredBefore
    : !!row.createdAt && row.createdAt < ctx.legacyCreatedBefore;
  if (expired) return 'expired';

  const { user } = ctx;
  if (!user) return 'userMissing';
  if (ctx.isAccountBlocked(user)) return 'accountBlocked';
  // Same normalization as isTokenVersionCurrent (@bike4mind/auth): a missing version is 0.
  if (row.tokenVersion !== undefined && row.tokenVersion !== null && row.tokenVersion !== (user.tokenVersion ?? 0)) {
    return 'tokenVersionStale';
  }

  if (row.sid && !isAuthSessionActive(ctx.session, ctx.now)) return 'sessionRevoked';

  if (row.apiKeyId) {
    const { apiKey } = ctx;
    const inactive = apiKey?.status === ApiKeyStatus.DISABLED || apiKey?.status === ApiKeyStatus.EXPIRED;
    if (!apiKey || inactive || (apiKey.expiresAt && apiKey.expiresAt <= ctx.now)) return 'apiKeyRevoked';
  }
  return null;
}

/** Which rows a sweep pass reads: live connections, then ended ones still owed a socket close. */
export type RealtimeSweepPhase = 'live' | 'ended';

export interface RealtimeSweepCursor {
  phase: RealtimeSweepPhase;
  /** Last _id of the previous page; null for the first page of the phase. */
  afterId: unknown;
}

export interface RealtimeSweepRow extends SweepRow {
  _id: unknown;
  connectionId: string;
  userId: string;
  endedAt?: Date | null;
}

export interface RealtimeSweepPage {
  rows: RealtimeSweepRow[];
  /** Cursor for the following page, or null when the phase is exhausted. */
  next: RealtimeSweepCursor | null;
}

/**
 * One page of Connection rows for the sweep, paged by _id so a failure in one page does not lose
 * the position. The 'live' phase relies on the model's default exclusion of ended rows; the
 * 'ended' phase names endedAt, which opts out of it.
 */
async function readSweepPage(cursor: RealtimeSweepCursor, batchSize = ID_CHUNK_SIZE): Promise<RealtimeSweepPage> {
  const filter: FilterQuery<unknown> = {
    ...(cursor.phase === 'ended' && { endedAt: { $exists: true } }),
    ...(cursor.afterId ? { _id: { $gt: cursor.afterId } } : {}),
  };
  const rows = (await Connection.find(filter).sort({ _id: 1 }).limit(batchSize).lean()) as RealtimeSweepRow[];
  const next =
    rows.length < batchSize || rows.length === 0 ? null : { phase: cursor.phase, afterId: rows[rows.length - 1]._id };
  return { rows, next };
}

/**
 * Decide which of these rows the sweep must act on. Live rows are flagged when their credential no
 * longer holds: auth expired (plus grace), user gone or blocked, tokenVersion bumped, session
 * revoked or expired, or API key no longer active; rows from before authExpiresAt existed fall
 * back to createdAt + the gateway's 2h cap. Ended rows are always targets ('ended'), or
 * 'endedLapsed' once they are older than any socket can live.
 *
 * `isAccountBlocked` is injected so the predicate stays userService.accountBlockReasons, not a copy.
 */
async function classifySweepRows(
  rows: readonly RealtimeSweepRow[],
  params: { now: Date; graceMs: number; isAccountBlocked: (user: RealtimeSweepUserState) => boolean }
): Promise<RealtimeSweepTarget[]> {
  const { now, graceMs, isAccountBlocked } = params;
  const expiredBefore = new Date(now.getTime() - graceMs);
  const legacyCreatedBefore = new Date(now.getTime() - REALTIME_CONNECTION_MAX_LIFETIME_MS - graceMs);
  const endedLapsedBefore = legacyCreatedBefore;
  const targets: RealtimeSweepTarget[] = [];

  const liveRows: RealtimeSweepRow[] = [];
  for (const row of rows) {
    if (!row.endedAt) {
      liveRows.push(row);
      continue;
    }
    targets.push({ connectionId: row.connectionId, reason: row.endedAt < endedLapsedBefore ? 'endedLapsed' : 'ended' });
  }
  if (liveRows.length === 0) return targets;

  // An id that cannot be an ObjectId matches nothing, so its row reads as user/key missing.
  const userIds = [...new Set(liveRows.map(row => row.userId))].filter(id => isValidObjectId(id));
  const sids = [...new Set(liveRows.flatMap(row => (row.sid ? [row.sid] : [])))];
  const apiKeyIds = [...new Set(liveRows.flatMap(row => (row.apiKeyId ? [row.apiKeyId] : [])))].filter(id =>
    isValidObjectId(id)
  );
  const [users, sessions, apiKeys] = await Promise.all([
    User.find({ _id: { $in: userIds } }, { tokenVersion: 1, isBanned: 1, disputePending: 1, moderation: 1 }).lean(),
    sids.length ? AuthSessionModel.find({ sid: { $in: sids } }, { sid: 1, revokedAt: 1, expiresAt: 1 }).lean() : [],
    apiKeyIds.length ? UserApiKey.find({ _id: { $in: apiKeyIds } }, { status: 1, expiresAt: 1 }).lean() : [],
  ]);
  const usersById = new Map(users.map(user => [String(user._id), user]));
  const sessionsBySid = new Map(sessions.map(session => [session.sid, session]));
  const apiKeysById = new Map(apiKeys.map(key => [String(key._id), key]));

  for (const row of liveRows) {
    const reason = sweepReason(row, {
      now,
      expiredBefore,
      legacyCreatedBefore,
      isAccountBlocked,
      user: usersById.get(row.userId),
      session: row.sid ? sessionsBySid.get(row.sid) : undefined,
      apiKey: row.apiKeyId ? apiKeysById.get(row.apiKeyId) : undefined,
    });
    if (reason) targets.push({ connectionId: row.connectionId, reason });
  }
  return targets;
}

/**
 * Subscriber entries whose Connection row is missing or ended: left by a crashed $disconnect, or
 * written back by the fanout service after a prune. (Connection reads skip ended rows, so "live"
 * below already excludes them.) Pulled in batches; returns how many connection ids were orphaned.
 */
async function removeOrphanSubscribers(batchSize = ID_CHUNK_SIZE): Promise<number> {
  const subscribed = (await QuerySubscription.distinct('subscribers.connectionId')) as string[];
  let removed = 0;
  for (const ids of chunk(subscribed, batchSize)) {
    const live = new Set((await Connection.find({ connectionId: { $in: ids } }).distinct('connectionId')) as string[]);
    const orphaned = ids.filter(id => !live.has(id));
    if (orphaned.length === 0) continue;
    await pullSubscribers(orphaned);
    removed += orphaned.length;
  }
  return removed;
}

/**
 * Subscriber entries on a live connection that were made before its last reauth_connection, i.e.
 * under the previous token. reauth pulls them itself; this catches one written back after that.
 * Returns how many entries were pulled.
 */
async function removeStaleSubscribers(batchSize = ID_CHUNK_SIZE): Promise<number> {
  let removed = 0;
  let afterId: unknown = null;
  for (;;) {
    const rows = await Connection.find({ reauthAt: { $exists: true }, ...(afterId ? { _id: { $gt: afterId } } : {}) })
      .select({ connectionId: 1, reauthAt: 1 })
      .sort({ _id: 1 })
      .limit(batchSize)
      .lean();
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1]._id;
    for (const { connectionId, reauthAt } of rows) {
      if (!reauthAt) continue;
      const stale = { connectionId, createdAt: { $lt: reauthAt } };
      const affected = await QuerySubscription.find({ subscribers: { $elemMatch: stale } }, { _id: 1 }).lean();
      if (affected.length === 0) continue;
      const affectedIds = affected.map(doc => doc._id);
      await QuerySubscription.updateMany({ _id: { $in: affectedIds } }, { $pull: { subscribers: stale } });
      await QuerySubscription.deleteMany({ _id: { $in: affectedIds }, subscribers: { $size: 0 } });
      removed += affected.length;
    }
    if (rows.length < batchSize) break;
  }
  return removed;
}

export const realtimeConnectionRepository = {
  endConnections,
  deleteEndedConnections,
  reauthenticate,
  readSweepPage,
  classifySweepRows,
  removeOrphanSubscribers,
  removeStaleSubscribers,
} satisfies IRealtimeConnectionRepository & Record<string, unknown>;
