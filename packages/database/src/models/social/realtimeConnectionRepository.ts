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

/**
 * Keeps a revoke-prune query out of any caller's transaction. Mongoose only injects the
 * transactionAsyncLocalStorage session when the `session` key is absent, so an explicit null opts
 * out: a failed prune cannot abort the caller's transaction, and its writes to the QuerySubscription
 * docs the fanout service shares never take transaction locks.
 */
function outsideTransaction<Q extends { session(session: null): Q }>(query: Q): Q {
  return query.session(null);
}

/** API Gateway closes every WebSocket after 2 hours, whatever the credential behind it. */
export const REALTIME_CONNECTION_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;

/**
 * removeStaleSubscribers only scans rows reauthed this recently: the fanout write-back race it
 * guards lasts seconds, so older rows need no scan.
 */
export const REALTIME_STALE_SCAN_WINDOW_MS = 15 * 60 * 1000;

/** Clock skew allowed between Lambdas: a subscriber made right after a reauth is never pulled. */
export const REALTIME_REAUTH_SKEW_MS = 60 * 1000;

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
    const affected = await outsideTransaction(
      QuerySubscription.find({ 'subscribers.connectionId': { $in: ids } }, { _id: 1 })
    ).lean();
    if (affected.length === 0) continue;
    const affectedIds = affected.map(doc => doc._id);
    await outsideTransaction(
      QuerySubscription.updateMany(
        { _id: { $in: affectedIds } },
        { $pull: { subscribers: { connectionId: { $in: ids } } } }
      )
    );
    await outsideTransaction(QuerySubscription.deleteMany({ _id: { $in: affectedIds }, subscribers: { $size: 0 } }));
  }
}

/**
 * Mark the connections' rows ended (kept, not deleted, so the sweep can still close the sockets),
 * then pull their subscribers. Only live rows are looked up by userId/sid/apiKeyId filters; an
 * explicit connectionIds filter is trusted as given. Never joins an ambient transaction (see
 * outsideTransaction), even when a revoke calls it from inside withTransaction.
 */
async function endConnections(filter: RealtimeConnectionFilter): Promise<EndRealtimeConnectionsResult> {
  const query = toConnectionQuery(filter);
  const connectionIds =
    'connectionIds' in filter
      ? [...new Set(filter.connectionIds)]
      : ((await outsideTransaction(Connection.find(query)).distinct('connectionId')) as string[]);
  if (connectionIds.length === 0) return { connectionIds: [] };

  // Rows first: once a row is ended, a concurrent subscribe re-checks it and backs out
  // (dataSubscribeRequest), so the pull below cannot be outrun. A crash in between leaves
  // subscribers on an ended row, which removeOrphanSubscribers pulls.
  const endedAt = new Date();
  for (const ids of chunk(connectionIds)) {
    await outsideTransaction(
      Connection.updateMany({ connectionId: { $in: ids }, endedAt: { $exists: false } }, { $set: { endedAt } })
    );
  }
  await pullSubscribers(connectionIds);
  return { connectionIds };
}

/**
 * End live connections whose auth had lapsed when they were classified, unless a reauth moved
 * authExpiresAt past `expiredBefore` since (a row without authExpiresAt counts as lapsed, as in the
 * sweep's classification). The guard is part of the update filter, so a row reauthed in between is
 * left alone. Returns the ids that are now ended: those are the sockets the caller may close.
 */
async function endExpiredConnections(connectionIds: readonly string[], expiredBefore: Date): Promise<string[]> {
  const stillLapsed = { $or: [{ authExpiresAt: null }, { authExpiresAt: { $lte: expiredBefore } }] };
  const ended: string[] = [];
  for (const ids of chunk([...new Set(connectionIds)])) {
    const candidates = (await Connection.find({ connectionId: { $in: ids }, ...stillLapsed }).distinct(
      'connectionId'
    )) as string[];
    if (candidates.length === 0) continue;
    await Connection.updateMany(
      { connectionId: { $in: candidates }, endedAt: { $exists: false }, ...stillLapsed },
      { $set: { endedAt: new Date() } }
    );
    const nowEnded = (await Connection.find({ connectionId: { $in: candidates }, endedAt: { $exists: true } })
      .setOptions({ includeEnded: true })
      .distinct('connectionId')) as string[];
    // Only rows the guarded update ended lose their subscriptions: a row reauthed in between stays live.
    if (nowEnded.length > 0) await pullSubscribers(nowEnded);
    ended.push(...nowEnded);
  }
  return ended;
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

export interface QuerySubscriptionIdentity {
  queryId: string;
  collectionName: string;
  query: Record<string, unknown>;
  fields?: Record<string, boolean | number>;
}

export interface QuerySubscriberIdentity {
  endpoint: string;
  connectionId: string;
  clientId: string;
}

// Bounds the re-check loop in upsertSubscriber; each pass only repeats because a concurrent writer won.
const UPSERT_SUBSCRIBER_MAX_PASSES = 3;

/**
 * Register a subscriber on a query, idempotently per (connectionId, clientId): a repeat subscribe
 * refreshes the existing entry's createdAt and resets its attempts instead of adding a second entry,
 * so a live re-subscription is never mistaken for a stale one (removeStaleSubscribers). Writes are
 * guarded so two concurrent subscribes cannot both add the entry to an existing doc; a concurrent
 * first subscribe can rarely create a second doc for the query (see below).
 */
async function upsertSubscriber(
  subscription: QuerySubscriptionIdentity,
  subscriber: QuerySubscriberIdentity
): Promise<void> {
  const { queryId, collectionName, query, fields } = subscription;
  const sameSubscriber = { $elemMatch: { connectionId: subscriber.connectionId, clientId: subscriber.clientId } };
  const entry = () => ({ ...subscriber, attempts: 0, createdAt: new Date() });

  for (let pass = 0; pass < UPSERT_SUBSCRIBER_MAX_PASSES; pass++) {
    const refreshed = await QuerySubscription.updateOne(
      { queryId, subscribers: sameSubscriber },
      {
        $set: { 'subscribers.$.createdAt': new Date(), 'subscribers.$.attempts': 0 },
        // A live re-subscription supersedes a recorded delivery failure; clear-resume-tokens.ts
        // pulls every entry still carrying one.
        $unset: { 'subscribers.$.errorReason': '' },
      }
    );
    if (refreshed.matchedCount > 0) return;

    const pushed = await QuerySubscription.updateOne(
      { queryId, subscribers: { $not: sameSubscriber } },
      { $push: { subscribers: entry() } }
    );
    if (pushed.matchedCount > 0) return;

    // Neither matched: the doc is missing, or another writer added this entry since the refresh.
    // Creating only when absent (an existing doc is left untouched) sends the second case round again.
    // queryId is not unique, so concurrent first subscribes can rarely create two docs for one query;
    // the fanout tolerates that. Doc _ids stay random: the fanout service keys state and deletes by _id.
    const created = await QuerySubscription.updateOne(
      { queryId },
      { $setOnInsert: { collectionName, query, fields, subscribers: [entry()] } },
      { upsert: true }
    );
    if (created.upsertedCount > 0) return;
  }
  throw new Error(`realtimeConnectionRepository: could not register subscriber ${subscriber.clientId}`);
}

/** Pull one connection's subscribers (used to back out a subscribe that raced its connection ending). */
async function removeConnectionSubscribers(connectionId: string): Promise<void> {
  assertNonEmptyString('connectionId', connectionId);
  await pullSubscribers([connectionId]);
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
  // Adopting a sid only succeeds on a row that still has none (or already carries that sid), so a
  // concurrent adoption by another session is never overwritten.
  const sidGuard = auth.sid ? { $or: [{ sid: { $exists: false } }, { sid: auth.sid }] } : {};
  const result = await Connection.updateOne(
    { connectionId, endedAt: { $exists: false }, ...sidGuard },
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
 * 'ended' phase opts out with the includeEnded query option.
 */
async function readSweepPage(cursor: RealtimeSweepCursor, batchSize = ID_CHUNK_SIZE): Promise<RealtimeSweepPage> {
  const filter: FilterQuery<unknown> = {
    ...(cursor.phase === 'ended' && { endedAt: { $exists: true } }),
    ...(cursor.afterId ? { _id: { $gt: cursor.afterId } } : {}),
  };
  const rows = (await Connection.find(filter)
    .setOptions({ includeEnded: cursor.phase === 'ended' })
    .sort({ _id: 1 })
    .limit(batchSize)
    .lean()) as RealtimeSweepRow[];
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
 * Subscriber entries on a recently reauthed live connection that were made before its last
 * reauth_connection, i.e. under the previous token. reauth pulls them itself; this catches one
 * written back after that. Only rows reauthed within REALTIME_STALE_SCAN_WINDOW_MS are scanned, and
 * only entries older than reauthAt minus REALTIME_REAUTH_SKEW_MS are pulled; an entry without a
 * createdAt is never pulled. A failure on one connection is logged and skipped.
 * Returns how many QuerySubscription docs had entries pulled (not how many entries).
 */
async function removeStaleSubscribers({
  batchSize = ID_CHUNK_SIZE,
  now = new Date(),
}: { batchSize?: number; now?: Date } = {}): Promise<number> {
  const scanFrom = new Date(now.getTime() - REALTIME_STALE_SCAN_WINDOW_MS);
  let removed = 0;
  let afterId: unknown = null;
  for (;;) {
    const rows = await Connection.find({ reauthAt: { $gte: scanFrom }, ...(afterId ? { _id: { $gt: afterId } } : {}) })
      .select({ connectionId: 1, reauthAt: 1 })
      .sort({ _id: 1 })
      .limit(batchSize)
      .lean();
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1]._id;
    for (const { connectionId, reauthAt } of rows) {
      if (!reauthAt) continue;
      try {
        const stale = { connectionId, createdAt: { $lt: new Date(reauthAt.getTime() - REALTIME_REAUTH_SKEW_MS) } };
        const affected = await QuerySubscription.find({ subscribers: { $elemMatch: stale } }, { _id: 1 }).lean();
        if (affected.length === 0) continue;
        const affectedIds = affected.map(doc => doc._id);
        await QuerySubscription.updateMany({ _id: { $in: affectedIds } }, { $pull: { subscribers: stale } });
        await QuerySubscription.deleteMany({ _id: { $in: affectedIds }, subscribers: { $size: 0 } });
        removed += affected.length;
      } catch (error) {
        console.warn(`[realtimeConnectionRepository] Failed to remove stale subscribers of ${connectionId}`, error);
      }
    }
    if (rows.length < batchSize) break;
  }
  return removed;
}

export const realtimeConnectionRepository = {
  endConnections,
  endExpiredConnections,
  deleteEndedConnections,
  reauthenticate,
  upsertSubscriber,
  removeConnectionSubscribers,
  readSweepPage,
  classifySweepRows,
  removeOrphanSubscribers,
  removeStaleSubscribers,
} satisfies IRealtimeConnectionRepository & Record<string, unknown>;
