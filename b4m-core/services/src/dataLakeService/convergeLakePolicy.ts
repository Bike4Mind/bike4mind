import {
  BULK_CHANGE_SHARE_PCT_DEFAULT,
  DEFAULT_PASSAGE_TOKEN_TARGET,
  isConvergeablePolicy,
  planLakeConvergence,
  requiresBulkChangeConfirmation,
  resolveLakeHealthPolicy,
  type ConvergenceCandidate,
  type ConvergenceSkipReason,
  type IAdminSettingsRepository,
  type IDataLakeDocument,
  type IDataLakeRepository,
  type IFabFileRepository,
  type IScopedSettingsRepository,
  type LakeConvergencePolicy,
} from '@bike4mind/common';
import { effectiveChunkTokenLimit } from '@bike4mind/fab-pipeline';
import { Logger } from '@bike4mind/observability';
import { buildLakeRequirements, findMemberLakesForFile } from './chunkPolicyConflict';
import { lakeMembershipScope } from './lakeMembershipScope';
import { resolveScopedSetting, scopeForLake } from '../settings/resolveScopedSetting';

/**
 * Owner-triggered convergence toward a lake's declared chunk policy (#1681).
 *
 * v1 is OWNER-TRIGGERED, SYSTEM-EXECUTED (epic decision 6). The owner asks for the repair; the
 * system performs it, so the actor is the system and nobody needs a lake-scoped write grant - which
 * is what dissolves the permission problem #1658 describes - while unattended spend and unattended
 * retrieval outage stay off the table. Continuous convergence is a v2 decision, to be revisited once
 * health data shows how much drift actually occurs.
 *
 * The pure decision lives in `@bike4mind/common`'s lakeConvergence module and is tested there. This
 * file is the IO around it: resolve the policy, read the members, refuse the members that would
 * oscillate, and hand the caller a bounded wave to enqueue.
 */

/**
 * Members reaching app memory per plan. Matches computeLakeHealth's bound - the same lake, the same
 * per-file rows - so an owner cannot see a health figure computed over more members than the plan
 * that repairs them.
 */
const MEMBER_SCAN_LIMIT = 25_000;

/** Default members rewritten per confirmed wave; small so one wave cannot burst the embedder's TPM. */
export const DEFAULT_CONVERGENCE_WAVE = 25;
/** Hard cap on one wave, so a hand-crafted request cannot fan out an unbounded embedding burst. */
export const MAX_CONVERGENCE_WAVE = 200;

/**
 * Why convergence refused the lake as a whole, before any member was graded. Distinct from a
 * per-member skip: these are lake-level facts an owner has to change before anything can converge.
 */
export type LakeConvergenceRefusal = 'policyInherited';

/**
 * A member refused because rewriting it to satisfy THIS lake would violate a different lake it also
 * belongs to. Reported per member rather than counted, because the fix is an operator decision
 * (align the two policies, or remove the file from one lake) and needs the other lake named.
 */
export type CrossLakeConflictMember = {
  fabFileId: string;
  fileName?: string;
  /** The disagreeing lakes, with the effective target each requires. */
  conflictingLakes: { lakeId?: string; name: string; effectiveRequiredTarget: number }[];
};

export type LakeConvergencePlanReport = {
  /** Set when the lake itself cannot converge; every count below is then zero. */
  refusal: LakeConvergenceRefusal | null;
  policy: LakeConvergencePolicy;
  /** Members graded - the denominator behind `changeShare`. */
  membersConsidered: number;
  /** Members that would be rewritten, AFTER the cross-lake refusal. */
  convergeableCount: number;
  /** Share of gradable members this run would rewrite, in [0,1]. */
  changeShare: number;
  /** True when `changeShare` is past the operator's threshold and the run needs confirmation. */
  requiresConfirmation: boolean;
  /** The resolved threshold, echoed so a caller can explain the guard without re-reading settings. */
  bulkChangeShareThreshold: number;
  skipped: Record<ConvergenceSkipReason, number>;
  /** Members refused for cross-lake disagreement, capped for payload size; count is exact. */
  crossLakeConflicts: CrossLakeConflictMember[];
  crossLakeConflictCount: number;
  /** True when the lake exceeded the member scan bound, so every count here is partial. */
  scanTruncated: boolean;
};

/** How many conflicting members the report names before it stops, so a payload stays bounded. */
const CROSS_LAKE_CONFLICTS_RETURNED = 50;

export type ConvergenceLake = Pick<
  IDataLakeDocument,
  'id' | 'name' | 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId' | 'organizationId' | 'requiredPassageTokenTarget'
>;

export interface ConvergenceAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'findLakeConvergenceMembers'>;
    dataLakes: Pick<IDataLakeRepository, 'find' | 'findByDatalakeTag'>;
    adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'>;
    scopedSettings?: Pick<IScopedSettingsRepository, 'findOverrides'>;
  };
  /** The embedding model both the lake's and each file's effective targets are computed against. */
  embeddingModel: string;
  logger?: Logger;
}

/**
 * Resolve the policy the lake converges toward. Built from the SAME `resolveLakeHealthPolicy` that
 * grades health, so an owner cannot see a lake reported as failing P1 and then have convergence
 * decide the very same members are conformant. The required target additionally goes through
 * `effectiveChunkTokenLimit` - the chunker's own model-window clamp - so the value compared against
 * a file's stamped `chunkedPassageTokenTarget` is like-for-like (#1662).
 */
async function resolveConvergencePolicy(
  lake: ConvergenceLake,
  { db, embeddingModel, logger }: ConvergenceAdapters
): Promise<{ policy: LakeConvergencePolicy; source: 'explicit' | 'inherited' }> {
  const resolved = await resolveScopedSetting(
    'DefaultChunkSize',
    scopeForLake(lake),
    { adminSettings: db.adminSettings, scopedSettings: db.scopedSettings },
    { logger }
  );
  const inheritedTarget =
    typeof resolved.value === 'number' && Number.isFinite(resolved.value) ? resolved.value : DEFAULT_PASSAGE_TOKEN_TARGET;

  const health = resolveLakeHealthPolicy({ explicitTarget: lake.requiredPassageTokenTarget, inheritedTarget });
  return {
    source: health.source,
    policy: {
      requiredTarget: health.chunkTokenTarget,
      effectiveRequiredTarget: effectiveChunkTokenLimit({
        model: embeddingModel,
        passageTokenTarget: health.chunkTokenTarget,
      }),
      policyChars: health.policyChars,
    },
  };
}

/** The operator's bulk-change share threshold, as a fraction in [0,1]. Never throws. */
async function resolveBulkChangeShareThreshold(
  lake: ConvergenceLake,
  { db, logger }: ConvergenceAdapters
): Promise<number> {
  const resolved = await resolveScopedSetting(
    'LakeConvergenceBulkChangeSharePct',
    scopeForLake(lake),
    { adminSettings: db.adminSettings, scopedSettings: db.scopedSettings },
    { logger }
  );
  // The fallback is the SAME constant the setting declares as its default, so a resolver failure
  // lands on the configured-default behaviour rather than a second, silently-diverging number.
  const pct =
    typeof resolved.value === 'number' && Number.isFinite(resolved.value)
      ? resolved.value
      : BULK_CHANGE_SHARE_PCT_DEFAULT;
  return Math.min(Math.max(pct, 1), 100) / 100;
}

/**
 * Refuse the members whose repair would start an oscillation.
 *
 * Chunk policy is file-owner altitude and chunks are keyed per FabFile, shared by every consumer of
 * that file (epic decision 7). Rewriting a member at THIS lake's target therefore also rewrites it
 * for every other lake it belongs to - and if one of those declares a DIFFERENT effective target,
 * the two lakes take turns pulling the file back and forth, re-embedding and billing on every pass
 * without ever converging. #1662 refuses to auto-re-chunk for exactly this reason; convergence is
 * allowed to, but only for members where the disagreement provably does not exist.
 *
 * Note this checks EVERY member lake that declares a requirement, not just the ones the file's
 * stored `chunkPolicyConflict` names: that record lists only the lakes currently VIOLATED, so a lake
 * the file happens to satisfy today is absent from it and would be silently broken by the rewrite.
 *
 * Runs on the bounded wave only, never the whole lake - it costs a lakes read per member.
 *
 * Deliberately does NOT catch: a lakes read that fails leaves this member's cross-lake status
 * UNKNOWN, and treating unknown as "no conflict" would re-chunk a file that another lake requires a
 * different target for - the one outcome this function exists to prevent. Failing the whole plan is
 * the correct direction; the owner re-triggers it.
 */
async function partitionCrossLakeConflicts(
  lake: ConvergenceLake,
  candidates: (ConvergenceCandidate & { tags: { name: string }[] })[],
  policy: LakeConvergencePolicy,
  { db, embeddingModel }: ConvergenceAdapters
): Promise<{ safe: ConvergenceCandidate[]; conflicts: CrossLakeConflictMember[] }> {
  const safe: ConvergenceCandidate[] = [];
  const conflicts: CrossLakeConflictMember[] = [];

  for (const candidate of candidates) {
    const memberLakes = await findMemberLakesForFile(
      { id: candidate.fabFileId, userId: candidate.userId, tags: candidate.tags },
      db.dataLakes
    );
    const disagreeing = buildLakeRequirements(memberLakes, embeddingModel).filter(
      requirement =>
        requirement.lakeId !== lake.id && requirement.effectiveRequiredTarget !== policy.effectiveRequiredTarget
    );

    if (disagreeing.length === 0) {
      safe.push({
        fabFileId: candidate.fabFileId,
        userId: candidate.userId,
        fileName: candidate.fileName,
        overshootChars: candidate.overshootChars,
      });
      continue;
    }
    conflicts.push({
      fabFileId: candidate.fabFileId,
      fileName: candidate.fileName,
      conflictingLakes: disagreeing.map(r => ({
        lakeId: r.lakeId,
        name: r.name,
        effectiveRequiredTarget: r.effectiveRequiredTarget,
      })),
    });
  }

  return { safe, conflicts };
}

/**
 * Plan a convergence run: what this lake would rewrite, what it refuses and why, and whether the
 * size of the change needs the owner to confirm it. Writes nothing and enqueues nothing - the
 * caller decides whether to execute. Safe to call repeatedly; it is the preview the owner reads.
 *
 * `waveLimit` bounds how many members are carried into the (per-member, DB-backed) cross-lake check
 * and returned as an executable wave.
 */
export async function planLakeConvergenceRun(
  lake: ConvergenceLake,
  adapters: ConvergenceAdapters,
  waveLimit: number = DEFAULT_CONVERGENCE_WAVE
): Promise<{ report: LakeConvergencePlanReport; wave: ConvergenceCandidate[] }> {
  const { db, logger } = adapters;
  const { policy, source } = await resolveConvergencePolicy(lake, adapters);
  const bulkChangeShareThreshold = await resolveBulkChangeShareThreshold(lake, adapters);

  const emptyReport = (refusal: LakeConvergenceRefusal | null): LakeConvergencePlanReport => ({
    refusal,
    policy,
    membersConsidered: 0,
    convergeableCount: 0,
    changeShare: 0,
    requiresConfirmation: false,
    bulkChangeShareThreshold,
    skipped: { conformant: 0, unmeasured: 0, indexingInFlight: 0, previouslyFailed: 0 },
    crossLakeConflicts: [],
    crossLakeConflictCount: 0,
    scanTruncated: false,
  });

  // Gate the WORK, not the use: a lake on the inherited platform default returns here without ever
  // reading a member, so "this lake does not converge" costs two cached settings reads and no
  // member scan - the scan is the expensive part, and it is what this gate stands in front of.
  if (!isConvergeablePolicy({ source })) {
    logger?.log?.(
      `[convergence] lake ${lake.id} has an inherited chunk policy; measured and reported, never repaired (epic decision 5)`
    );
    // Logged rather than returned silently: "the button did nothing" and "the lake declares no
    // policy" are indistinguishable from the outside otherwise, and this is the arm a smoke test
    // needs to tell apart from "never ran".

    return { report: emptyReport('policyInherited'), wave: [] };
  }

  // Defense in depth, mirroring computeLakeHealth: an absent datalakeTag would serialize to null in
  // the membership $match and degrade the query to "files with no tags" across every tenant.
  if (!lake.datalakeTag) {
    logger?.warn?.(`[convergence] lake ${lake.id} has no datalakeTag; refusing to plan a run over an unscoped match`);
    return { report: emptyReport(null), wave: [] };
  }

  const rows = await db.fabFiles.findLakeConvergenceMembers(lakeMembershipScope(lake), MEMBER_SCAN_LIMIT);
  const scanTruncated = rows.length > MEMBER_SCAN_LIMIT;
  const members = scanTruncated ? rows.slice(0, MEMBER_SCAN_LIMIT) : rows;
  if (scanTruncated) {
    logger?.warn?.(
      `[convergence] lake ${lake.id} exceeds ${MEMBER_SCAN_LIMIT} members; planned over the first ${MEMBER_SCAN_LIMIT}. ` +
        'Every count in this plan is partial - see scanTruncated.'
    );
  }

  const plan = planLakeConvergence(members, policy);
  const tagsById = new Map(members.map(m => [m.fabFileId, m.tags ?? []]));
  const withTags = plan.candidates
    .slice(0, Math.min(waveLimit, MAX_CONVERGENCE_WAVE))
    .map(c => ({ ...c, tags: tagsById.get(c.fabFileId) ?? [] }));

  const { safe, conflicts } = await partitionCrossLakeConflicts(lake, withTags, policy, adapters);

  // The share is computed over the whole lake's candidates, NOT the wave: the guard asks "how much
  // of this lake would this policy rewrite", and a wave limit of 25 would otherwise make every run
  // on a 1000-member lake look like a 2.5% change.
  const requiresConfirmation = requiresBulkChangeConfirmation(plan, bulkChangeShareThreshold);

  if (conflicts.length > 0) {
    logger?.warn?.(
      `[convergence] lake ${lake.id}: ${conflicts.length} member(s) in this wave belong to a lake requiring a ` +
        'different chunk target and were refused; repairing them would oscillate between the two lakes'
    );
  }

  return {
    report: {
      refusal: null,
      policy,
      membersConsidered: plan.membersConsidered,
      convergeableCount: plan.candidates.length,
      changeShare: plan.changeShare,
      requiresConfirmation,
      bulkChangeShareThreshold,
      skipped: plan.skipped,
      crossLakeConflicts: conflicts.slice(0, CROSS_LAKE_CONFLICTS_RETURNED),
      crossLakeConflictCount: conflicts.length,
      scanTruncated,
    },
    wave: safe,
  };
}
