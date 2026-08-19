import type {
  IDataLakeDocument,
  ILakeConfigChangeEventDocument,
  ILakeConfigChangeEventRepository,
  ILakeConfigFieldChange,
  IUserRepository,
  LakeConfigHistoryEntry,
  LakeConfigHistoryFieldChange,
  LakeConfigHistoryView,
} from '@bike4mind/common';

/**
 * Default cap on config-change events read for one history view. Deliberately small: config writes
 * are rare by nature (an operator action each), so a window this deep already reaches years back on
 * a real lake, while the rows are wider (each carries a change array) and every one of them is
 * rendered rather than folded into a count.
 */
export const LAKE_CONFIG_HISTORY_LIMIT = 200;

/** Hard ceiling on a caller-supplied limit, so a request cannot ask for an unbounded page. */
export const LAKE_CONFIG_HISTORY_MAX_LIMIT = 500;

/**
 * Clamp a requested page size into `[1, LAKE_CONFIG_HISTORY_MAX_LIMIT]`, falling back to the default
 * for anything absent or non-finite. Total (never throws) because it sits behind a query parameter:
 * a garbage `?limit=` must serve the default page, not 500 the history.
 */
export function clampLakeConfigHistoryLimit(requested?: number): number {
  if (requested == null || !Number.isFinite(requested)) return LAKE_CONFIG_HISTORY_LIMIT;
  const floored = Math.floor(requested);
  if (floored < 1) return 1;
  return Math.min(floored, LAKE_CONFIG_HISTORY_MAX_LIMIT);
}

/**
 * Whether an id can be handed to `userRepository.findByIds` at all. That repository converts ids
 * through `convertIds`, whose `new ObjectId(id)` THROWS on anything not 24-hex - which would turn
 * one unresolvable principal into a 500 for the entire history. Config events legitimately carry
 * non-ObjectId principal ids: `recordLakeConfigChange` writes `principalId: 'system'` for a write no
 * principal drove, and an API-key principal carries a key id.
 *
 * Kept as a local regex rather than importing mongoose (this package must not depend on the DB
 * driver). #1672's `findByIds` hardening makes the same guard redundant at the repository, but this
 * one is what keeps the endpoint honest on a build that predates it - and a filtered id could never
 * have matched a real `_id` anyway.
 */
const isObjectIdShaped = (id: string): boolean => /^[0-9a-fA-F]{24}$/.test(id);

/**
 * A display name for a user, best-effort: real name, else username, else undefined. Deliberately
 * does NOT fall back to email - the same rule the access view applies, and for the same reason: a
 * lake accumulates principals across tenants, so surfacing an address as a "name" would disclose an
 * identity the manager reading this was never meant to see. An unresolved user renders as its
 * opaque id.
 */
const userDisplayName = (u: { name?: string; username?: string } | undefined): string | undefined =>
  u ? u.name || u.username || undefined : undefined;

/**
 * Map one persisted event to its view row, WITHOUT name resolution - pure, so the shape is testable
 * without a user repository. `changes` is passed through by reference: the event is immutable and
 * this view is serialized straight out, so copying it would buy nothing.
 */
export function toLakeConfigHistoryEntry(
  event: Pick<
    ILakeConfigChangeEventDocument,
    'id' | 'createdAt' | 'principalKind' | 'principalId' | 'onBehalfOfUserId' | 'manageRung' | 'action' | 'changes'
  >
): LakeConfigHistoryEntry {
  return {
    eventId: event.id,
    changedAt: event.createdAt,
    principalKind: event.principalKind,
    principalId: event.principalId,
    onBehalfOfUserId: event.onBehalfOfUserId,
    manageRung: event.manageRung,
    action: event.action,
    changes: event.changes.map(toHistoryFieldChange),
  };
}

/**
 * Narrow a stored change to its wire form, dropping the fingerprint hash.
 *
 * Built by naming the fields to KEEP rather than by spreading and deleting `hash`: an allowlist
 * fails safe when the stored fingerprint grows a field, a denylist ships it. The literal arm passes
 * through untouched - it holds only values the reader is already entitled to see.
 */
function toHistoryFieldChange(change: ILakeConfigFieldChange): LakeConfigHistoryFieldChange {
  if (change.kind !== 'fingerprint') return change;
  return {
    field: change.field,
    kind: 'fingerprint',
    beforeFingerprint: { present: change.beforeFingerprint.present, length: change.beforeFingerprint.length },
    afterFingerprint: { present: change.afterFingerprint.present, length: change.afterFingerprint.length },
    // The hash comparison happens HERE, where the hashes are already in hand, so the answer crosses
    // instead of the inputs. Both sides must be present: two absent values share the empty-string
    // hash, and calling that "unchanged text" would be true but useless - the caller renders that
    // case as "still not set" from `present` alone.
    textUnchanged:
      change.beforeFingerprint.present &&
      change.afterFingerprint.present &&
      change.beforeFingerprint.hash === change.afterFingerprint.hash,
  };
}

export interface AssembleLakeConfigHistoryAdapters {
  db: {
    lakeConfigChangeEvents: Pick<ILakeConfigChangeEventRepository, 'listByLake'>;
    users: Pick<IUserRepository, 'findByIds'>;
  };
  /** Page size; clamped through `clampLakeConfigHistoryLimit`. */
  limit?: number;
  /** Injectable clock so `generatedAt` is deterministic in tests. */
  now?: Date;
}

/**
 * Assemble the owner-facing config-change history (#1769) for one already-resolved lake: who changed
 * how this lake answers, what moved, and which manage rung let them. Read-only.
 *
 * The CALLER owns authorization and must have confirmed the actor can MANAGE the lake before calling
 * (the history describes editor-only fields, so it sits at the same altitude as the fields
 * themselves - a mere reader must not see it). This function assumes that gate has already passed.
 *
 * Entries stay chronological and un-aggregated - see `LakeConfigHistoryEntry`.
 */
export async function assembleLakeConfigHistory(
  lake: Pick<IDataLakeDocument, 'id' | 'name'>,
  { db, limit, now = new Date() }: AssembleLakeConfigHistoryAdapters
): Promise<LakeConfigHistoryView> {
  const pageSize = clampLakeConfigHistoryLimit(limit);
  // One row MORE than the page, purely as a probe: fetching exactly `pageSize` cannot distinguish
  // "this lake has exactly that many events" from "there are more behind this page", and calling a
  // complete history truncated makes a consumer caption the lake's whole life as "changes since
  // <date>". The extra row is never returned - it is sliced off below.
  const events = await db.lakeConfigChangeEvents.listByLake(lake.id, { limit: pageSize + 1 });
  const truncated = events.length > pageSize;
  const windowEvents = truncated ? events.slice(0, pageSize) : events;
  const entries = windowEvents.map(toLakeConfigHistoryEntry);

  // One batched name resolution across every id worth looking up. Only USER-kind principals and the
  // on-behalf human are candidates - a system/agent/apiKey principalId names no user record - and
  // each is shape-checked so a malformed id cannot 500 the view (see isObjectIdShaped).
  const userIds = new Set<string>();
  for (const entry of entries) {
    if (entry.principalKind === 'user' && isObjectIdShaped(entry.principalId)) userIds.add(entry.principalId);
    if (entry.onBehalfOfUserId && isObjectIdShaped(entry.onBehalfOfUserId)) userIds.add(entry.onBehalfOfUserId);
  }
  const users = userIds.size > 0 ? await db.users.findByIds(Array.from(userIds)) : [];
  const userNameById = new Map(users.map(u => [u.id, userDisplayName(u)]));

  return {
    lakeId: lake.id,
    lakeName: lake.name,
    entries: entries.map(entry => ({
      ...entry,
      principalName: entry.principalKind === 'user' ? userNameById.get(entry.principalId) : undefined,
      onBehalfOfName: entry.onBehalfOfUserId ? userNameById.get(entry.onBehalfOfUserId) : undefined,
    })),
    truncated,
    // The window's oldest event, so a consumer can say "changes since <date>" instead of implying
    // the list is all-time. Events come back newest-first, so that is the last element.
    windowStartsAt: truncated ? entries[entries.length - 1]?.changedAt : undefined,
    generatedAt: now,
  };
}
