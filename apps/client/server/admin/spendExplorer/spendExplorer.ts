import { AdminAuditLogModel, Organization, User, usageEventRepository } from '@bike4mind/database';
import {
  CreditHolderType,
  DEFAULT_ACCOUNT_SEGMENT,
  type AccountSegment,
  type SpendAccountRow,
  type SpendAccountsResponse,
  type SpendBucketSize,
  type SpendSegmentIds,
  type SpendSplitDimension,
  type SpendTimelineMarker,
  type SpendTimelineResponse,
} from '@bike4mind/common';
import { SUSPEND_ACTIONS } from '@bike4mind/server-utils/security/accountStatusAuditActions';
import { lookbackStart, normalizeProvider, shapeTimeline } from './shapeTimeline';

const MAX_TIME_MS = 20_000;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const MAX_MARKERS = 50;
const NEW_IN_TOP = 10;

/**
 * Ids of every account tagged internal or partner. Users are internal through the
 * existing `isInternal` flag (the one source of truth for that) and partner through
 * `accountSegment`; organizations carry `accountSegment` alone. Tagged accounts are
 * few, so the lists stay small enough to inline into the aggregation's $in.
 */
export async function loadSegmentIds(): Promise<SpendSegmentIds> {
  const [users, orgs] = await Promise.all([
    User.find({ $or: [{ isInternal: true }, { accountSegment: { $in: ['internal', 'partner'] } }] })
      .select('_id isInternal accountSegment')
      .maxTimeMS(MAX_TIME_MS)
      .lean<Array<{ _id: unknown; isInternal?: boolean; accountSegment?: AccountSegment }>>(),
    Organization.find({ accountSegment: { $in: ['internal', 'partner'] } })
      .select('_id accountSegment')
      .maxTimeMS(MAX_TIME_MS)
      .lean<Array<{ _id: unknown; accountSegment?: AccountSegment }>>(),
  ]);
  const ids: SpendSegmentIds = { internal: [], partner: [] };
  for (const user of users) {
    const segment = user.isInternal ? 'internal' : user.accountSegment;
    if (segment === 'internal' || segment === 'partner') ids[segment].push(String(user._id));
  }
  for (const org of orgs) {
    if (org.accountSegment === 'internal' || org.accountSegment === 'partner') {
      ids[org.accountSegment].push(String(org._id));
    }
  }
  return ids;
}

const segmentOf = (id: string, ids: SpendSegmentIds): AccountSegment =>
  ids.internal.includes(id) ? 'internal' : ids.partner.includes(id) ? 'partner' : DEFAULT_ACCOUNT_SEGMENT;

/** Admin suspensions in the window (from the audit log), as timeline markers. */
async function loadSuspensionMarkers(from: Date, to: Date, userId?: string): Promise<SpendTimelineMarker[]> {
  const filter: Record<string, unknown> = { action: { $in: SUSPEND_ACTIONS }, occurredAt: { $gte: from, $lt: to } };
  if (userId) filter['target.id'] = userId;
  const rows = await AdminAuditLogModel.find(filter)
    .select('occurredAt')
    .sort({ occurredAt: 1 })
    .limit(MAX_MARKERS)
    .maxTimeMS(MAX_TIME_MS)
    .lean<Array<{ occurredAt: Date }>>();
  return rows.map(row => ({ at: row.occurredAt.toISOString(), kind: 'suspension', label: 'Account suspended' }));
}

export type TimelineQuery = {
  from: Date;
  to: Date;
  bucket: SpendBucketSize;
  splitBy: SpendSplitDimension;
  /** Narrow to the events one user ran, whoever paid. */
  actorUserId?: string;
};

/** `from`/`to` must already sit on bucket boundaries. */
export async function buildTimeline(query: TimelineQuery): Promise<SpendTimelineResponse> {
  // Only the segment split reads the tags; skip the lookup otherwise.
  const segmentIds = query.splitBy === 'segment' ? await loadSegmentIds() : { internal: [], partner: [] };
  const [rows, markers] = await Promise.all([
    usageEventRepository.spendTimeline({
      from: lookbackStart(query.from, query.to, query.bucket),
      to: query.to,
      bucket: query.bucket,
      splitBy: query.splitBy,
      segmentIds,
      actorUserId: query.actorUserId,
    }),
    loadSuspensionMarkers(query.from, query.to, query.actorUserId),
  ]);
  const { seriesKeys, buckets } = shapeTimeline({ rows, ...query });
  return { bucket: query.bucket, splitBy: query.splitBy, seriesKeys, buckets, markers };
}

type AccountInfo = { name: string; createdAt: Date | null };

/** Names and creation times for the actors and their payers, keyed by id. */
export async function resolveAccountInfo(
  accounts: Array<{ id: string; type: CreditHolderType }>
): Promise<Map<string, AccountInfo>> {
  const idsOf = (type: CreditHolderType) =>
    [...new Set(accounts.filter(a => a.type === type).map(a => a.id))].filter(id => OBJECT_ID_RE.test(id));
  const userIds = idsOf(CreditHolderType.User);
  const orgIds = idsOf(CreditHolderType.Organization);

  const [users, orgs] = await Promise.all([
    userIds.length
      ? User.find({ _id: { $in: userIds } })
          .select('_id name username createdAt')
          .maxTimeMS(MAX_TIME_MS)
          .lean<Array<{ _id: unknown; name?: string; username?: string; createdAt?: Date }>>()
      : [],
    orgIds.length
      ? Organization.find({ _id: { $in: orgIds } })
          .select('_id name createdAt')
          .maxTimeMS(MAX_TIME_MS)
          .lean<Array<{ _id: unknown; name?: string; createdAt?: Date }>>()
      : [],
  ]);
  const info = new Map<string, AccountInfo>();
  for (const user of users) {
    info.set(String(user._id), {
      name: user.name || user.username || String(user._id),
      createdAt: user.createdAt ?? null,
    });
  }
  for (const org of orgs) {
    info.set(String(org._id), { name: org.name || String(org._id), createdAt: org.createdAt ?? null });
  }
  return info;
}

function foldProviders(
  rows: Array<{ provider: string; costUsd: number }>
): Array<{ provider: string; costUsd: number }> {
  const folded = new Map<string, number>();
  for (const row of rows) {
    const provider = normalizeProvider(row.provider);
    folded.set(provider, (folded.get(provider) ?? 0) + row.costUsd);
  }
  return [...folded.entries()]
    .map(([provider, costUsd]) => ({ provider, costUsd }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

export type AccountsQuery = {
  from: Date;
  to: Date;
  limit: number;
  compare?: { from: Date; to: Date };
};

export async function buildAccounts(query: AccountsQuery): Promise<SpendAccountsResponse> {
  const segmentIds = await loadSegmentIds();
  const [current, previous] = await Promise.all([
    usageEventRepository.spendBreakdown({ from: query.from, to: query.to, limit: query.limit, segmentIds }),
    query.compare
      ? usageEventRepository.spendBreakdown({ ...query.compare, limit: NEW_IN_TOP, segmentIds })
      : Promise.resolve(null),
  ]);
  const previousTop = new Set(previous?.topActors.map(actor => actor.userId) ?? []);
  const info = await resolveAccountInfo(
    current.topActors.flatMap(actor => [
      { id: actor.userId, type: CreditHolderType.User },
      ...actor.payers.map(payer => ({ id: payer.ownerId, type: payer.ownerType })),
    ])
  );
  // Unresolved ids (agent pools, legacy ids) show raw.
  const nameOf = (id: string) => info.get(id)?.name ?? id;

  const accounts: SpendAccountRow[] = current.topActors.map((actor, index) => {
    const createdAt = info.get(actor.userId)?.createdAt;
    const ownSegment = segmentOf(actor.userId, segmentIds);
    const primaryPayer = actor.payers[0];
    return {
      accountId: actor.userId,
      name: nameOf(actor.userId),
      // The user's own tag wins; otherwise they inherit the tag of whoever paid most of their spend.
      segment:
        ownSegment !== DEFAULT_ACCOUNT_SEGMENT || !primaryPayer
          ? ownSegment
          : segmentOf(primaryPayer.ownerId, segmentIds),
      costUsd: actor.costUsd,
      share: current.totalCostUsd > 0 ? actor.costUsd / current.totalCostUsd : 0,
      requests: actor.requests,
      createdAt: createdAt ? createdAt.toISOString() : null,
      payers: actor.payers.map(payer => ({ ...payer, name: nameOf(payer.ownerId) })),
      newInTop10: previous !== null && index < NEW_IN_TOP && !previousTop.has(actor.userId),
    };
  });

  return {
    totalCostUsd: current.totalCostUsd,
    byProvider: foldProviders(current.byProvider),
    bySegment: current.bySegment,
    accounts,
  };
}
