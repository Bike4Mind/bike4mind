/**
 * Per-run convergence-pause map for the chunk rescue sweep (#2157).
 *
 * Every OTHER convergence producer knows its lake, so it resolves `PauseLakeConvergence` through the
 * scoped resolver and honours a per-lake / per-org / per-owner override. The rescue sweep is the one
 * that does not: it is a single global query over `FabFile`, so there is no one lake for the resolver
 * to narrow with, and both halves of the path used to read the raw platform value - the selection
 * filter AND (because the enqueued message carried no `lakeId`) the handler's own re-check. A scoped
 * pause therefore leaked in exactly the direction an operator would not expect: the narrower, more
 * cautious setting was the one being ignored.
 *
 * The observation this module is built on: a lake with NO override resolves to the platform value, so
 * a `lakeId` changes NOTHING for it. Only the lakes carrying an override can disagree with the
 * platform switch - and the setting's whole override set is one small, indexed read
 * (`findBySettingName`). So the sweep reads that set once per run, and:
 *
 *  - if it is EMPTY (the overwhelmingly common case) nothing further is read and the sweep behaves
 *    exactly as the platform-only sweep that shipped in #2120 did;
 *  - otherwise it loads just the lakes those rows can reach, grades each one, and hands the result to
 *    both halves of the sweep.
 *
 * Which makes the two halves DIFFERENT KINDS of thing, and that asymmetry is deliberate:
 *
 *  - the ENQUEUE is the correctness gate. `pickScopedLakeId` puts the deciding lake on the message,
 *    so `isConvergenceHalted` resolves the same scoped value every other producer does. A file whose
 *    lake is paused is bounced and marked; a file whose lake overrides the platform switch back OFF
 *    is genuinely rebuilt.
 *  - the SELECTION clause is a cap-fairness optimisation. It keeps already-marked files of a paused
 *    lake from spending the per-run rescue cap. It is best-effort by construction (a multi-lake file
 *    can satisfy a broader arm than the handler's single-lake verdict), which is safe precisely
 *    because the handler above is the gate.
 */
import {
  DataLakeMembershipScope,
  IAdminSettingsRepository,
  IDataLakeDocument,
  IDataLakeRepository,
  IScopedSetting,
  IScopedSettingsRepository,
  SettingScopeLevel,
} from '@bike4mind/common';
import { buildDataLakeMembershipFilter } from '@bike4mind/database';
import { dataLakeService, scopedSettingsService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { CONVERGENCE_PAUSE_SETTING_KEY } from '@server/queueHandlers/convergenceKillSwitch';
import { CONVERGENCE_ORIGIN, WorkOrigin } from '@server/queueHandlers/convergenceProvenance';
// Type-only, so this does NOT pull the sweep's filter module into anyone's runtime graph. Imported
// rather than restated so the compiler holds the produced shape and the consumed shape together.
import type { ChunkScanConvergencePause } from '@server/worker/chunkScan';

/** The lake fields the grading and the membership predicate need. */
export type PausableLake = Pick<
  IDataLakeDocument,
  'id' | 'name' | 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId' | 'organizationId' | 'requiredPassageTokenTarget'
>;

/** One lake the override set can reach, with its EFFECTIVE pause value. */
export interface GradedLake {
  lake: PausableLake;
  /**
   * The lake's membership address, built ONCE and used by both halves: `buildDataLakeMembershipFilter`
   * turns it into the selection clause, and `satisfiesMembershipScope` answers the same question in
   * memory for the enqueue. Sharing the object is what makes it impossible for the two to disagree
   * about who is a member - they are the Mongo and JS sides of one predicate, keyed on one input.
   */
  scope: DataLakeMembershipScope;
  /** The resolved `PauseLakeConvergence` for this lake - narrowest rung wins, platform as the base. */
  paused: boolean;
}

export interface ConvergencePauseScope {
  /** The platform switch. The value every lake NOT in `scopedLakes` resolves to. */
  platformPaused: boolean;
  /**
   * Only the lakes an override row can reach. A lake absent from here resolves to `platformPaused`,
   * which is why omitting it costs nothing - and why an empty array means the whole run behaves
   * exactly as the platform-only sweep did.
   */
  scopedLakes: readonly GradedLake[];
}

/** The file fields `pickScopedLakeId` reads - what the sweep's `_id userId tags` projection yields. */
export interface PauseScopeCandidate {
  userId?: string | null;
  tags?: { name: string; strength: number }[] | null;
}

export interface ConvergencePauseScopeDeps {
  adminSettings: Pick<IAdminSettingsRepository, 'getSettingsValue'>;
  scopedSettings: Pick<IScopedSettingsRepository, 'findBySettingName'>;
  dataLakes: Pick<IDataLakeRepository, 'find'>;
}

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/**
 * The lakes an override row set can possibly reach, as ONE query.
 *
 * A Lake-rung row addresses a lake directly. An Owner- or Organization-rung row addresses a
 * principal, and `scopeForLake` derives a lake's owner rung from `organizationId` (org-owned) or
 * `createdByUserId` (individual) - so a principal id is matched against BOTH fields rather than the
 * caller guessing which kind of id it is. Deliberately over-broad: `resolveScopedSettingFromOverrides`
 * re-derives each lake's real rungs and hands a lake the row does not actually address the platform
 * value, so a wide candidate set costs a grade, never a wrong verdict.
 *
 * Returns `null` when the rows address nothing queryable, so the caller can skip the read entirely.
 */
export function buildScopedLakeFilter(
  rows: readonly Pick<IScopedSetting, 'scopeLevel' | 'scopeId'>[]
): Record<string, unknown> | null {
  const lakeIds = new Set<string>();
  const principalIds = new Set<string>();
  for (const row of rows) {
    // A malformed scopeId would make Mongoose's ObjectId cast throw and take the whole sweep with it,
    // so the `_id` arm only ever sees hex ids. A principal id needs no such guard - both fields it is
    // matched against are plain strings.
    if (row.scopeLevel === SettingScopeLevel.Lake) {
      if (OBJECT_ID_HEX.test(row.scopeId)) lakeIds.add(row.scopeId);
      continue;
    }
    principalIds.add(row.scopeId);
  }

  const arms: Record<string, unknown>[] = [];
  if (lakeIds.size > 0) arms.push({ _id: { $in: [...lakeIds] } });
  if (principalIds.size > 0) {
    arms.push({ createdByUserId: { $in: [...principalIds] } }, { organizationId: { $in: [...principalIds] } });
  }
  return arms.length > 0 ? { $or: arms } : null;
}

/**
 * Resolve this run's pause map.
 *
 * Deliberately does NOT degrade a failed READ into a verdict. Every read here answers "is this lake
 * paused", and the only safe answer to a failed read is "unknown" - so the reads propagate and abort
 * this pass. Defaulting unknown to "not paused" is what would hurt: with the platform switch OFF and
 * the override set unread, the sweep selects a scoped-paused lake's files AND enqueues them without a
 * `lakeId`, so the handler resolves platform-only too and re-chunks them. That rewrites passages an
 * operator asked to freeze and spends embedding budget doing it - a write no later success can undo,
 * traded against the only cost of aborting, which is rescue latency until the next pass.
 *
 * (The two failure directions are not equally bad - degrading with the switch ON would merely
 * over-exclude, which self-heals on the next successful pass. One rule anyway: the asymmetry is
 * harder to hold in your head than it is worth, and if this collection is unreadable the FabFile
 * query the sweep is about to issue is unlikely to fare better.)
 *
 * ONE case does degrade, and it is not a read failure: override rows that address nothing queryable.
 * That is a permanent data condition, so aborting on it would disable the sweep indefinitely rather
 * than until the next pass. It warns instead.
 *
 * Logs whenever there is a pause to honour - the switch is ON, or an override exists - so a smoke test
 * can tell "resolved, nothing was paused" from "the resolution never ran". Deliberately SILENT when the
 * switch is off and nothing is overridden: there is no verdict to get wrong, the sweep's own
 * `Sweep complete` line already proves it ran, and this runs every 60s on self-host.
 */
export async function resolveConvergencePauseScope(
  deps: ConvergencePauseScopeDeps,
  logger?: Logger
): Promise<ConvergencePauseScope> {
  const platformPaused = (await deps.adminSettings.getSettingsValue(CONVERGENCE_PAUSE_SETTING_KEY)) === true;

  const rows = await deps.scopedSettings.findBySettingName(CONVERGENCE_PAUSE_SETTING_KEY);
  // Gate the WORK, not the use: with no override anywhere there is no lake whose verdict could
  // differ from the platform switch, so the lakes read never happens.
  if (rows.length === 0) {
    // Only worth a line while the switch is ON. Then an operator is watching for the pause to bite,
    // and silence here would be indistinguishable from the sweep never reaching this resolution at all
    // (e.g. returning early on enableAutoChunk) - which is exactly what a live smoke test cannot tell
    // apart from the outside.
    if (platformPaused) {
      logger?.log?.('[convergencePauseScope] platform pause ON; no scoped overrides, so every lake is paused');
    }
    return { platformPaused, scopedLakes: [] };
  }

  const lakeFilter = buildScopedLakeFilter(rows);
  if (!lakeFilter) {
    logger?.warn?.(
      `[convergencePauseScope] ${rows.length} pause override row(s) address no queryable scope; ` +
        'resolving the platform value only'
    );
    return { platformPaused, scopedLakes: [] };
  }

  const lakes = (await deps.dataLakes.find(lakeFilter)) as PausableLake[];
  const resolved = scopedSettingsService.resolveScopedSettingFromOverrides(
    CONVERGENCE_PAUSE_SETTING_KEY,
    lakes.map(lake => scopedSettingsService.scopeForLake(lake)),
    platformPaused,
    rows,
    logger
  );
  const scopedLakes = lakes.map((lake, i) => ({
    lake,
    scope: membershipScopeForLake(lake),
    paused: resolved[i].value === true,
  }));
  logger?.log?.(
    `[convergencePauseScope] platform pause ${platformPaused ? 'ON' : 'OFF'}; ` +
      `${scopedLakes.filter(g => g.paused).length}/${scopedLakes.length} override-reachable lake(s) paused`
  );
  return { platformPaused, scopedLakes };
}

/**
 * The `lakeId` to stamp on this candidate's chunk message, or `undefined` to leave the handler on the
 * platform value.
 *
 * Membership is `satisfiesMembershipScope` against the very scope object the selection clause is
 * built from - the in-memory mirror of `buildDataLakeMembershipFilter`, keyed on the same
 * `DataLakeMembershipScope` - so the producer and the query cannot disagree about who is a member.
 *
 * A PAUSED member lake wins over a running one, which is the conservative direction and the one an
 * operator expects: chunks are keyed per file and shared by every lake holding it, so re-chunking for
 * a running lake would rewrite the paused lake's passages too - the exact write it asked to stop.
 * With no paused member, a running member is still stamped: that is what makes an override of the
 * platform switch back to OFF reach this path, instead of the platform ON value halting the file.
 */
export function pickScopedLakeId(candidate: PauseScopeCandidate, scope: ConvergencePauseScope): string | undefined {
  if (scope.scopedLakes.length === 0) return undefined;
  const file = { userId: candidate.userId ?? '', tags: candidate.tags ?? [] };
  const members = scope.scopedLakes.filter(graded => dataLakeService.satisfiesMembershipScope(graded.scope, file));
  return (members.find(graded => graded.paused) ?? members[0])?.lake.id;
}

/**
 * The pause half of the sweep's selection filter, in the shape `buildFabFileChunkScanFilter` takes.
 *
 * Split by which direction the platform switch points, because that decides which side of the
 * override set is load-bearing:
 *
 *  - platform ON: every lake is paused EXCEPT the ones overriding back to OFF, so those lakes'
 *    memberships are the exemption (`running`) and everything else marked-as-paused is excluded.
 *    With no such override this is exactly #2120's unconditional exclusion.
 *  - platform OFF: nothing is paused except the lakes overriding to ON, so only their members are
 *    excluded (`paused`). With no such override there is nothing to exclude, which is the
 *    pre-#2120 behaviour and the automatic rebuild a pause marker's own wording promises.
 */
export function toChunkScanConvergencePause(scope: ConvergencePauseScope): ChunkScanConvergencePause {
  const membership = (graded: GradedLake): Record<string, unknown> => buildDataLakeMembershipFilter(graded.scope);
  return {
    platformPaused: scope.platformPaused,
    paused: scope.scopedLakes.filter(g => g.paused).map(membership),
    running: scope.scopedLakes.filter(g => !g.paused).map(membership),
  };
}

/**
 * The membership address of a DB-backed lake. Always `kind: 'owned'` - every lake here came out of the
 * lakes collection, and the `registry` arm is for the hardcoded DATA_LAKES entries, which have no
 * document and so can carry no scoped override to reach this module in the first place.
 */
function membershipScopeForLake(lake: PausableLake): DataLakeMembershipScope {
  return {
    kind: 'owned',
    datalakeTag: lake.datalakeTag,
    fileTagPrefix: lake.fileTagPrefix,
    creatorUserId: lake.createdByUserId,
  };
}

/** The lean projection the sweep selects, as both drivers hand it over. */
export interface ChunkRescueCandidate extends PauseScopeCandidate {
  _id: unknown;
}

/**
 * The chunk-queue message body the rescue sweep sends. Mirrors `ChunkFabFilePayload` (the shape the
 * handler parses). Extends `Record<string, unknown>` so it satisfies `sendToQueue`'s parameter, which
 * takes any JSON-able body - naming the fields is still worth it here, because the whole point of
 * this type is that `lakeId` is part of the contract rather than an afterthought.
 */
export interface ChunkRescueMessage extends Record<string, unknown> {
  fabFileId: string;
  userId: string;
  origin: WorkOrigin;
  lakeId?: string;
}

/**
 * The chunk message for one rescue candidate. Shared by both sweep drivers (the hosted
 * `dataLakeBatchReconcile` cron and the self-host worker) so they cannot stamp provenance
 * differently, and it lives beside `pickScopedLakeId` because `origin` and `lakeId` are one decision:
 * a `lakeId` the handler would never look at is as useless as a scope-less halt.
 *
 * `origin` marks the work HALTABLE and is stamped UNCONDITIONALLY (#2309), not just for a file
 * carrying a `batchId` or a resolved `lakeId`. A scheduled rescue sweep is background work by
 * definition: with the switch on, the chunk handler parks a file with a stall reason but leaves it
 * matching the scan filter, and an un-stamped re-enqueue is read as `user` work
 * (`isConvergenceHalted` fails soft to `user`) and chunked in full anyway - spending exactly the
 * budget the switch was set to stop, and silently, because a successful run clears the stall marker.
 * The tradeoff, which is the switch working as designed: while it is on, the sweep rescues nothing,
 * including a genuinely stranded non-lake file. What brings such a file back is RE-SELECTION, not a
 * resume path - the scan filter excludes the stall reasons only while the switch is on, so the first
 * sweep after it clears re-admits the file and rebuilds it.
 *
 * `lakeId` is the part #2157 adds, and it is what makes the halt SCOPED rather than platform-only:
 * with it on the message, `isConvergenceHalted` resolves the same per-lake / per-org / per-owner
 * value every other producer does, so a lake overriding the platform switch back OFF is genuinely
 * rebuilt instead of bounced. Only a lake carrying an override can produce one - a lake with no
 * override resolves to the platform value, so a `lakeId` would change nothing for it.
 *
 * A candidate in no overridden lake therefore gets `origin` but no `lakeId`, which resolves to the
 * platform value: haltable while the switch is on, rescued the moment it is off.
 *
 * One shape does NOT come back, and stamping unconditionally is what routes it there: a MEDIA file is
 * admitted by the scan filter only through `chunkRebuildRequestedAt`, and the halt write nulls that
 * field, so once halted it leaves the filter for good and needs a manual reprocess. Tracked in #2224.
 */
export function buildChunkRescueMessage(
  candidate: ChunkRescueCandidate,
  scope: ConvergencePauseScope
): ChunkRescueMessage {
  const lakeId = pickScopedLakeId(candidate, scope);
  return {
    fabFileId: String(candidate._id),
    userId: String(candidate.userId),
    origin: CONVERGENCE_ORIGIN,
    ...(lakeId ? { lakeId } : {}),
  };
}
