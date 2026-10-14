import {
  ApiKeyStatus,
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
  'expired' | 'userMissing' | 'accountBlocked' | 'tokenVersionStale' | 'sessionRevoked' | 'apiKeyRevoked';

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

function toConnectionQuery(filter: RealtimeConnectionFilter): FilterQuery<unknown> {
  if ('connectionIds' in filter) return { connectionId: { $in: filter.connectionIds } };
  if ('sid' in filter) return { sid: filter.sid };
  if ('apiKeyId' in filter) return { apiKeyId: filter.apiKeyId };
  return {
    userId: filter.userId,
    ...(filter.exceptSid && { sid: { $ne: filter.exceptSid } }),
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

async function endConnections(filter: RealtimeConnectionFilter): Promise<EndRealtimeConnectionsResult> {
  const connectionIds =
    'connectionIds' in filter
      ? [...new Set(filter.connectionIds)]
      : ((await Connection.find(toConnectionQuery(filter)).distinct('connectionId')) as string[]);
  if (connectionIds.length === 0) return { connectionIds: [] };

  // Subscribers first: a crash in between leaves a row the sweep still finds, never a subscriber
  // entry whose row is already gone.
  await pullSubscribers(connectionIds);
  for (const ids of chunk(connectionIds)) {
    await Connection.deleteMany({ connectionId: { $in: ids } });
  }
  return { connectionIds };
}

/**
 * Re-stamp a connection with a freshly verified access token and drop all its subscriptions, so
 * the client re-subscribes under the new token (and the ACL scope is re-evaluated). Returns false
 * when the row is gone.
 */
async function reauthenticate(
  connectionId: string,
  auth: { tokenVersion: number; authExpiresAt: Date; sid?: string }
): Promise<boolean> {
  const result = await Connection.updateOne({ connectionId }, { $set: auth });
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

  if (row.sid) {
    const { session } = ctx;
    if (!session || session.revokedAt || session.expiresAt <= ctx.now) return 'sessionRevoked';
  }

  if (row.apiKeyId) {
    const { apiKey } = ctx;
    const inactive = apiKey?.status === ApiKeyStatus.DISABLED || apiKey?.status === ApiKeyStatus.EXPIRED;
    if (!apiKey || inactive || (apiKey.expiresAt && apiKey.expiresAt <= ctx.now)) return 'apiKeyRevoked';
  }
  return null;
}

/**
 * Connections whose credential no longer holds: auth expired (plus grace), user gone or blocked,
 * tokenVersion bumped, session revoked or expired, or API key no longer active. Rows from before
 * authExpiresAt existed fall back to createdAt + the gateway's 2h cap.
 *
 * `isAccountBlocked` is injected so the predicate stays userService.accountBlockReasons, not a copy.
 */
async function findSweepTargets(params: {
  now: Date;
  graceMs: number;
  isAccountBlocked: (user: RealtimeSweepUserState) => boolean;
  batchSize?: number;
}): Promise<RealtimeSweepTarget[]> {
  const { now, graceMs, isAccountBlocked } = params;
  const batchSize = params.batchSize ?? ID_CHUNK_SIZE;
  const expiredBefore = new Date(now.getTime() - graceMs);
  const legacyCreatedBefore = new Date(now.getTime() - REALTIME_CONNECTION_MAX_LIFETIME_MS - graceMs);
  const targets: RealtimeSweepTarget[] = [];

  let lastId: unknown = null;
  for (;;) {
    const rows = await Connection.find(lastId ? { _id: { $gt: lastId } } : {})
      .sort({ _id: 1 })
      .limit(batchSize)
      .lean();
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1]._id;

    // An id that cannot be an ObjectId matches nothing, so its row reads as user/key missing.
    const userIds = [...new Set(rows.map(row => row.userId))].filter(id => isValidObjectId(id));
    const sids = [...new Set(rows.flatMap(row => (row.sid ? [row.sid] : [])))];
    const apiKeyIds = [...new Set(rows.flatMap(row => (row.apiKeyId ? [row.apiKeyId] : [])))].filter(id =>
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

    for (const row of rows) {
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

    if (rows.length < batchSize) break;
  }
  return targets;
}

/**
 * Subscriber entries whose Connection row no longer exists: left by a crashed $disconnect, or
 * written back by the fanout service after a prune. Pulled in batches; returns how many
 * connection ids were orphaned.
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

export const realtimeConnectionRepository = {
  endConnections,
  reauthenticate,
  findSweepTargets,
  removeOrphanSubscribers,
} satisfies IRealtimeConnectionRepository & Record<string, unknown>;
