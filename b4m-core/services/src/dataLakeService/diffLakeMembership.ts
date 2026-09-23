import type {
  IDataLakeDocument,
  IFabFileRepository,
  ILakeMembershipChangeEventDocument,
  ILakeMembershipChangeEventRepository,
  IUserRepository,
  LakeMembershipDiffEntry,
  LakeMembershipDiffUnknownReason,
  LakeMembershipDiffView,
} from '@bike4mind/common';
import { resolveLakeMembershipScope } from './lakeMembershipScope';

/**
 * Default cap on membership events read for one diff. Larger than the config history's page
 * because these rows are narrow (one file, one action) and an ingest run emits one per file, so a
 * single connector sync can fill hundreds on its own.
 */
export const LAKE_MEMBERSHIP_DIFF_LIMIT = 500;

/** Hard ceiling on a caller-supplied limit, so a request cannot ask for an unbounded read. */
export const LAKE_MEMBERSHIP_DIFF_MAX_LIMIT = 2000;

/**
 * Clamp a requested page size into `[1, LAKE_MEMBERSHIP_DIFF_MAX_LIMIT]`, falling back to the
 * default for anything absent or non-finite. Total (never throws) because it sits behind a query
 * parameter.
 */
export function clampLakeMembershipDiffLimit(requested?: number): number {
  if (requested == null || !Number.isFinite(requested)) return LAKE_MEMBERSHIP_DIFF_LIMIT;
  const floored = Math.floor(requested);
  if (floored < 1) return 1;
  return Math.min(floored, LAKE_MEMBERSHIP_DIFF_MAX_LIMIT);
}

/** See `assembleLakeConfigHistory`'s guard of the same name: `findByIds` throws on a non-ObjectId,
 * and a membership event legitimately carries `system` or an API-key id as its principal. */
const isObjectIdShaped = (id: string): boolean => /^[0-9a-fA-F]{24}$/.test(id);

/** Best-effort display name, never falling back to email - the rule the config history and access
 * view both apply, since a lake accumulates principals across tenants. */
const userDisplayName = (u: { name?: string; username?: string } | undefined): string | undefined =>
  u ? u.name || u.username || undefined : undefined;

export interface DiffLakeMembershipAdapters {
  db: {
    lakeMembershipChangeEvents: Pick<ILakeMembershipChangeEventRepository, 'listByLakeSince' | 'oldestEventAt'>;
    fabFiles: Pick<IFabFileRepository, 'findIdsByDataLakeTag'>;
    users: Pick<IUserRepository, 'findByIds'>;
  };
  /** Exclusive lower bound of the window. */
  from: Date;
  /** Inclusive upper bound; defaults to now and is clamped to it. */
  to?: Date;
  limit?: number;
  /** Injectable clock so `generatedAt` and the `to` clamp are deterministic in tests. */
  now?: Date;
}

/** One file's run of events inside the window, oldest first. */
interface FileWindow {
  memberAtFrom: boolean;
  memberAtTo: boolean;
  last: ILakeMembershipChangeEventDocument;
  flips: number;
}

const toEntry = (w: FileWindow): LakeMembershipDiffEntry => ({
  fabFileId: w.last.fabFileId,
  eventId: w.last.id,
  changedAt: w.last.createdAt,
  origin: w.last.origin,
  principalKind: w.last.principalKind,
  principalId: w.last.principalId,
  onBehalfOfUserId: w.last.onBehalfOfUserId,
  flips: w.flips,
});

/**
 * Diff one already-resolved lake's membership between two instants: what joined, what left, how
 * many files sat through it, and who drove each move.
 *
 * The CALLER owns authorization and must have confirmed the actor can MANAGE the lake - this
 * describes the lake's contents over time, the same altitude as the config history.
 *
 * Three facts are combined, because no two of them suffice:
 *  - the events after `from`, which give every move and its actor;
 *  - the events after `to`, which rewind today's membership back to the window's end;
 *  - today's membership, which is the only record of a file that never moved.
 * The last one is why `unchangedCount` is conditional: it is a claim about files the log says
 * nothing about, and that claim only holds while the log covers the whole window.
 */
export async function diffLakeMembership(
  lake: Pick<IDataLakeDocument, 'id' | 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId'>,
  { db, from, to, limit, now = new Date() }: DiffLakeMembershipAdapters
): Promise<LakeMembershipDiffView> {
  const windowEnd = to && to.getTime() < now.getTime() ? to : now;
  const pageSize = clampLakeMembershipDiffLimit(limit);

  const scope = resolveLakeMembershipScope(lake);
  const [page, logStartsAt, memberIds] = await Promise.all([
    // One row MORE than the page, purely as a truncation probe - the same device the config
    // history uses, and here it also decides whether `unchangedCount` may be reported at all.
    db.lakeMembershipChangeEvents.listByLakeSince(lake.id, from, { limit: pageSize + 1 }),
    db.lakeMembershipChangeEvents.oldestEventAt(lake.id),
    db.fabFiles.findIdsByDataLakeTag(scope),
  ]);
  const truncated = page.length > pageSize;
  // Truncation drops the OLDEST rows, so the surviving newest ones still rewind today's membership
  // correctly; only the early part of the window goes missing.
  const events = (truncated ? page.slice(0, pageSize) : page)
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  // Membership at the window's end: today's set, rewound through everything recorded since. The
  // EARLIEST event after `to` is what names the state at `to` - an `added` means the file was
  // absent then, a `removed` means it was present.
  const membersAtTo = new Set(memberIds);
  const rewound = new Set<string>();
  for (const e of events) {
    if (e.createdAt.getTime() <= windowEnd.getTime()) continue;
    if (rewound.has(e.fabFileId)) continue;
    rewound.add(e.fabFileId);
    if (e.action === 'added') membersAtTo.delete(e.fabFileId);
    else membersAtTo.add(e.fabFileId);
  }

  const windows = new Map<string, FileWindow>();
  for (const e of events) {
    if (e.createdAt.getTime() > windowEnd.getTime()) continue;
    const existing = windows.get(e.fabFileId);
    if (existing) {
      existing.memberAtTo = e.action === 'added';
      existing.last = e;
      existing.flips += 1;
      continue;
    }
    windows.set(e.fabFileId, {
      // The first move in the window reveals the state before it.
      memberAtFrom: e.action === 'removed',
      memberAtTo: e.action === 'added',
      last: e,
      flips: 1,
    });
  }

  const added: LakeMembershipDiffEntry[] = [];
  const removed: LakeMembershipDiffEntry[] = [];
  for (const w of windows.values()) {
    if (!w.memberAtFrom && w.memberAtTo) added.push(toEntry(w));
    else if (w.memberAtFrom && !w.memberAtTo) removed.push(toEntry(w));
  }
  const newestFirst = (a: LakeMembershipDiffEntry, b: LakeMembershipDiffEntry) =>
    b.changedAt.getTime() - a.changedAt.getTime();
  added.sort(newestFirst);
  removed.sort(newestFirst);

  // A file with no rows in the window is called "sat through it" purely because nothing says
  // otherwise - so that claim is only made when the log demonstrably covers the whole window.
  // A lake with no retained events fails this too: silence is not evidence of stillness.
  const unchangedUnknownReason: LakeMembershipDiffUnknownReason | undefined = truncated
    ? 'window-truncated'
    : !logStartsAt || logStartsAt.getTime() > from.getTime()
      ? 'window-predates-log'
      : undefined;
  let unchangedCount: number | undefined;
  if (!unchangedUnknownReason) {
    unchangedCount = 0;
    for (const fileId of membersAtTo) {
      const w = windows.get(fileId);
      if (!w || w.memberAtFrom) unchangedCount += 1;
    }
  }

  const userIds = new Set<string>();
  for (const entry of [...added, ...removed]) {
    if (entry.principalKind === 'user' && isObjectIdShaped(entry.principalId)) userIds.add(entry.principalId);
    if (entry.onBehalfOfUserId && isObjectIdShaped(entry.onBehalfOfUserId)) userIds.add(entry.onBehalfOfUserId);
  }
  const users = userIds.size > 0 ? await db.users.findByIds(Array.from(userIds)) : [];
  const userNameById = new Map(users.map(u => [u.id, userDisplayName(u)]));
  const withNames = (entries: LakeMembershipDiffEntry[]) =>
    entries.map(entry => ({
      ...entry,
      principalName: entry.principalKind === 'user' ? userNameById.get(entry.principalId) : undefined,
      onBehalfOfName: entry.onBehalfOfUserId ? userNameById.get(entry.onBehalfOfUserId) : undefined,
    }));

  return {
    lakeId: lake.id,
    from,
    to: windowEnd,
    added: withNames(added),
    removed: withNames(removed),
    unchangedCount,
    unchangedUnknownReason,
    logStartsAt,
    truncated,
    generatedAt: now,
    userNames: Object.fromEntries(
      Array.from(userNameById).filter((pair): pair is [string, string] => pair[1] !== undefined)
    ),
  };
}
