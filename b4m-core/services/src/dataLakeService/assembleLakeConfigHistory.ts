import type {
  IDataLakeDocument,
  ILakeConfigChangeEventDocument,
  ILakeConfigChangeEventRepository,
  ILakeConfigFieldChange,
  ILakeConfigUndoClaimRepository,
  ILakeMembershipChangeEventDocument,
  ILakeMembershipChangeEventRepository,
  IDataLakeResearchConfigRepository,
  IFabFileRepository,
  IUserApiKeyRepository,
  IUserRepository,
  LakeConfigHistoryConfigEntry,
  LakeConfigHistoryEntry,
  LakeConfigHistoryFileEntry,
  LakeConfigHistoryFieldChange,
  LakeConfigHistoryView,
} from '@bike4mind/common';
import { classifyConfigUndo, classifyFileUndo, type UndoClassification } from './lakeChangeUndoability';
import { satisfiesMembershipScope } from './lakeMembership';
import { resolveLakeMembershipScope } from './lakeMembershipScope';

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
 * Whether an id can be handed to `userRepository.findByIds` or an `_id: { $in }` query at all. The
 * former converts ids through `convertIds`, whose `new ObjectId(id)` THROWS on anything not 24-hex,
 * and the latter throws a CastError - either would turn one unresolvable principal into a 500 for
 * the entire history. Config events legitimately carry non-ObjectId principal ids:
 * `recordLakeConfigChange` writes `principalId: 'system'` for a write no principal drove, and an
 * API-key principal carries a key id.
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
 *
 * Duplicate of the exported `userDisplayName` in `assembleLakeAccessView.ts`.
 */
const userDisplayName = (u: { name?: string; username?: string } | undefined): string | undefined =>
  u ? u.name || u.username || undefined : undefined;

/**
 * Map one persisted event to its view row, WITHOUT name resolution - pure, so the shape is testable
 * without a user repository. Each change is narrowed to its wire form on the way out - see
 * `toHistoryFieldChange`.
 */
export function toLakeConfigHistoryEntry(
  event: Pick<
    ILakeConfigChangeEventDocument,
    | 'id'
    | 'createdAt'
    | 'principalKind'
    | 'principalId'
    | 'onBehalfOfUserId'
    | 'manageRung'
    | 'action'
    | 'changes'
    | 'target'
    | 'leverChanges'
    | 'admittedFabFileId'
    | 'undoesEventId'
  >
): LakeConfigHistoryConfigEntry {
  return {
    kind: 'config',
    eventId: event.id,
    changedAt: event.createdAt,
    principalKind: event.principalKind,
    principalId: event.principalId,
    onBehalfOfUserId: event.onBehalfOfUserId,
    manageRung: event.manageRung,
    action: event.action,
    changes: event.changes.map(toHistoryFieldChange),
    target: event.target,
    leverChanges: event.leverChanges,
    admittedFabFileId: event.admittedFabFileId,
    undoesEventId: event.undoesEventId,
  };
}

/** A membership event as a History row: the file is the target, and the log carries no rung or prose. */
export function toLakeFileHistoryEntry(
  event: Pick<
    ILakeMembershipChangeEventDocument,
    | 'id'
    | 'createdAt'
    | 'principalKind'
    | 'principalId'
    | 'onBehalfOfUserId'
    | 'fabFileId'
    | 'action'
    | 'origin'
    | 'undoesEventId'
    | 'causedByEventId'
  >
): LakeConfigHistoryFileEntry {
  return {
    kind: 'file',
    eventId: event.id,
    changedAt: event.createdAt,
    principalKind: event.principalKind,
    principalId: event.principalId,
    onBehalfOfUserId: event.onBehalfOfUserId,
    action: event.action === 'added' ? 'file-added' : 'file-removed',
    target: { kind: 'file', id: event.fabFileId },
    origin: event.origin,
    undoesEventId: event.undoesEventId,
    causedByEventId: event.causedByEventId,
  };
}

/** Newest first. The sort is stable, so same-millisecond rows keep each repository's own order. */
const byNewest = (a: LakeConfigHistoryEntry, b: LakeConfigHistoryEntry): number =>
  b.changedAt.getTime() - a.changedAt.getTime();

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
    lakeMembershipChangeEvents: Pick<ILakeMembershipChangeEventRepository, 'listByLake'>;
    users: Pick<IUserRepository, 'findByIds'>;
    userApiKeys: Pick<IUserApiKeyRepository, 'find'>;
    /** Absent on a caller that predates Undo: no row is then marked undoable or undone. */
    lakeConfigUndoClaims?: Pick<ILakeConfigUndoClaimRepository, 'listForEvents'>;
    /** Absent: every created config is assumed to still exist, so its Undo is offered. */
    dataLakeResearchConfigs?: Pick<IDataLakeResearchConfigRepository, 'find'>;
    /** Absent: file rows carry no name. */
    fabFiles?: Pick<IFabFileRepository, 'find'>;
  };
  /** The reader: a file they own is named even after it left the lake. */
  viewerUserId?: string;
  /** Page size; clamped through `clampLakeConfigHistoryLimit`. */
  limit?: number;
  /** Also return file add/remove rows. Off by default: callers that predate them expect config rows only. */
  includeFiles?: boolean;
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
/**
 * The audited fields whose VALUES are user ids. Deliberately just these two: `organizationId` and
 * `preferredSystemPromptId` are ids as well, but of other entities, so putting them through a user
 * lookup would produce a confidently wrong name rather than a missing one.
 *
 * `effectiveOwnerUserId`'s `before` can be a COMMA-JOINED set - `ownershipChange` joins the prior
 * owners rather than emitting a list, because the value shape is scalar - so each side is split.
 */
const IDENTITY_VALUE_FIELDS = new Set(['effectiveOwnerUserId', 'createdByUserId']);

/** Every ObjectId-shaped user id appearing as a VALUE in one entry's changes. */
function identityValueIds(changes: readonly LakeConfigHistoryFieldChange[]): string[] {
  const ids: string[] = [];
  for (const change of changes) {
    if (change.kind !== 'literal' || !IDENTITY_VALUE_FIELDS.has(change.field)) continue;
    for (const side of [change.before, change.after]) {
      if (typeof side !== 'string') continue;
      for (const id of side.split(',')) if (isObjectIdShaped(id)) ids.push(id);
    }
  }
  return ids;
}

export async function assembleLakeConfigHistory(
  lake: Pick<IDataLakeDocument, 'id' | 'name' | 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId'>,
  { db, limit, includeFiles = false, viewerUserId, now = new Date() }: AssembleLakeConfigHistoryAdapters
): Promise<LakeConfigHistoryView> {
  const pageSize = clampLakeConfigHistoryLimit(limit);
  // One row MORE than the page, purely as a probe: fetching exactly `pageSize` cannot distinguish
  // "this lake has exactly that many events" from "there are more behind this page", and calling a
  // complete history truncated makes a consumer caption the lake's whole life as "changes since
  // <date>". The extra row is never returned - it is sliced off below.
  const configProbe = await db.lakeConfigChangeEvents.listByLake(lake.id, { limit: pageSize + 1 });
  const configTruncated = configProbe.length > pageSize;
  const configWindow = configProbe.slice(0, pageSize);
  const configEntries = configWindow.map(toLakeConfigHistoryEntry);
  // One read for every config a create row targets. A config that was deleted, or deleted and
  // restored under a new id, leaves its create row with nothing to undo.
  const createdConfigIds = [
    ...new Set(
      configWindow
        .filter(e => e.action === 'create-research-config' && e.target?.kind === 'researchConfig')
        .map(e => e.target!.id)
        .filter(isObjectIdShaped)
    ),
  ];
  const liveConfigIds =
    db.dataLakeResearchConfigs && createdConfigIds.length > 0
      ? new Set(
          (await db.dataLakeResearchConfigs.find({ dataLakeId: lake.id, _id: { $in: createdConfigIds } })).map(
            c => c.id
          )
        )
      : undefined;
  const undoFacts = new Map<string, UndoClassification>(
    configWindow.map(event => [
      event.id,
      classifyConfigUndo(
        event,
        now,
        !liveConfigIds || event.target?.kind !== 'researchConfig' || liveConfigIds.has(event.target.id)
      ),
    ])
  );

  let fileEntries: LakeConfigHistoryFileEntry[] = [];
  let filesTruncated = false;
  if (includeFiles) {
    // Config rows own the window: file rows older than the oldest kept config row are dropped, so a
    // burst of file events (a connector sync writes one per file) can never evict a config row.
    const oldestConfigAt = configTruncated ? configEntries[configEntries.length - 1]?.changedAt : undefined;
    const fileProbe = (await db.lakeMembershipChangeEvents.listByLake(lake.id, { limit: pageSize + 1 }))
      .map(toLakeFileHistoryEntry)
      .filter(entry => !oldestConfigAt || entry.changedAt >= oldestConfigAt);
    filesTruncated = fileProbe.length > pageSize;
    fileEntries = fileProbe.slice(0, pageSize);
    // Classified from the entry: the file row carries every field the classifier reads.
    for (const entry of fileEntries) {
      undoFacts.set(
        entry.eventId,
        classifyFileUndo(
          {
            action: entry.action === 'file-added' ? 'added' : 'removed',
            causedByEventId: entry.causedByEventId,
            createdAt: entry.changedAt,
          },
          now
        )
      );
    }
  }

  const entries: LakeConfigHistoryEntry[] = [...configEntries, ...fileEntries].sort(byNewest);

  // The claim is the source of truth for "undone"; the undoing row is only a convenience link, and
  // may be outside the window or never have persisted.
  const claims = db.lakeConfigUndoClaims
    ? await db.lakeConfigUndoClaims.listForEvents(
        lake.id,
        entries.map(entry => entry.eventId)
      )
    : [];
  const claimByEvent = new Map(claims.map(claim => [claim.eventId, claim]));
  const inWindow = new Set(entries.map(entry => entry.eventId));
  const undoerByEvent = new Map<string, string>();
  for (const entry of entries) if (entry.undoesEventId) undoerByEvent.set(entry.undoesEventId, entry.eventId);
  for (const entry of entries) {
    if (!db.lakeConfigUndoClaims) break;
    const facts = undoFacts.get(entry.eventId);
    const claim = claimByEvent.get(entry.eventId);
    entry.undone = !!claim;
    entry.undoable = !claim && !!facts?.plan;
    const undoer =
      undoerByEvent.get(entry.eventId) ??
      (claim?.undoEventId && inWindow.has(claim.undoEventId) ? claim.undoEventId : undefined);
    if (undoer) entry.undoneByEventId = undoer;
    if (!claim && !facts?.plan && facts?.note) entry.undoNote = facts.note;
  }

  const truncated = configTruncated || filesTruncated;
  // History is complete only from the later of the two streams' cut-offs.
  const cutoffs = [
    configTruncated ? configEntries[configEntries.length - 1]?.changedAt : undefined,
    filesTruncated ? fileEntries[fileEntries.length - 1]?.changedAt : undefined,
  ].filter((d): d is Date => d !== undefined);
  const windowStartsAt = cutoffs.length > 0 ? new Date(Math.max(...cutoffs.map(d => d.getTime()))) : undefined;

  // One batched name resolution across every id worth looking up. Only USER-kind principals and the
  // on-behalf human are candidates - a system/agent/apiKey principalId names no user record - and
  // each is shape-checked so a malformed id cannot 500 the view (see isObjectIdShaped). API-key
  // principals resolve through their own batch into a separate map, so a key name can never land in
  // `userNames` or `onBehalfOfName`.
  const userIds = new Set<string>();
  const keyIds = new Set<string>();
  for (const entry of entries) {
    if (entry.principalKind === 'apiKey' && isObjectIdShaped(entry.principalId)) keyIds.add(entry.principalId);
    if (entry.principalKind === 'user' && isObjectIdShaped(entry.principalId)) userIds.add(entry.principalId);
    if (entry.onBehalfOfUserId && isObjectIdShaped(entry.onBehalfOfUserId)) userIds.add(entry.onBehalfOfUserId);
    // Identity fields carry user ids as their VALUES, and the transfer row is the one an owner most
    // comes here for - unresolved it reads as two opaque hex strings in the column that exists to
    // say what changed. Folded into the SAME batch as the principals, so this costs no extra round
    // trip however many rows reference an identity.
    if (entry.kind === 'config') for (const id of identityValueIds(entry.changes)) userIds.add(id);
  }
  const fileIds = [
    ...new Set(
      entries.flatMap(entry => (entry.kind === 'file' && isObjectIdShaped(entry.target.id) ? [entry.target.id] : []))
    ),
  ];
  const [users, keys, files] = await Promise.all([
    userIds.size > 0 ? db.users.findByIds(Array.from(userIds)) : [],
    // The soft-delete plugin's find hook skips deleted keys, so a deleted key falls back to its id.
    // Do not pass `includeDeleted` here.
    keyIds.size > 0 ? db.userApiKeys.find({ _id: { $in: Array.from(keyIds) } }) : [],
    // A deleted file has no row to name, so its entry keeps showing the id.
    db.fabFiles && fileIds.length > 0 ? db.fabFiles.find({ _id: { $in: fileIds } }) : [],
  ]);
  // Managing the lake entitles the reader to its current members, not to files that have left it.
  const membership = resolveLakeMembershipScope(lake);
  const fileNameById = new Map(
    files
      .filter(f => !f.deletedAt && f.fileName)
      .filter(f => satisfiesMembershipScope(membership, f) || (!!viewerUserId && f.userId === viewerUserId))
      .map(f => [f.id, f.fileName])
  );
  const userNameById = new Map(users.map(u => [u.id, userDisplayName(u)]));
  const keyNameById = new Map(keys.map(k => [k.id, k.name || undefined]));

  return {
    lakeId: lake.id,
    lakeName: lake.name,
    entries: entries.map(entry => ({
      ...entry,
      ...(entry.kind === 'file' && fileNameById.has(entry.target.id)
        ? { fileName: fileNameById.get(entry.target.id) }
        : {}),
      principalName:
        entry.principalKind === 'user'
          ? userNameById.get(entry.principalId)
          : entry.principalKind === 'apiKey'
            ? keyNameById.get(entry.principalId)
            : undefined,
      onBehalfOfName: entry.onBehalfOfUserId ? userNameById.get(entry.onBehalfOfUserId) : undefined,
    })),
    truncated,
    // So a consumer can say "changes since <date>" instead of implying the list is all-time.
    windowStartsAt,
    generatedAt: now,
    // Only the ids that actually resolved to a NAME. Absent covers both "no user record" and "a user
    // with neither name nor username" - userDisplayName deliberately never falls back to email - and
    // in both cases the consumer's raw-id fallback is what should fire, not an empty cell.
    userNames: Object.fromEntries(
      Array.from(userNameById).filter((pair): pair is [string, string] => pair[1] !== undefined)
    ),
  };
}
