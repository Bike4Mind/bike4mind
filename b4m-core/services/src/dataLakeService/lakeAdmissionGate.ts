import {
  DEFAULT_PASSAGE_TOKEN_TARGET,
  type FabFileChunkPolicyConflictLake,
  type IDataLakeDocument,
} from '@bike4mind/common';
import { effectiveChunkTokenLimit } from '@bike4mind/fab-pipeline';
import { BadRequestError } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { buildLakeRequirements, findViolatedLakeRequirements } from './chunkPolicyConflict';
import {
  resolveScopedSetting,
  scopeForFileOwner,
  scopeForLake,
  type ScopedSettingsDb,
} from '../settings/resolveScopedSetting';

/**
 * The retrievability contract ENFORCED at admission (#1680), the hard-gate half of the report-only
 * admission contract in `admissionContract.ts` (#1679). It reads the same signal that file's chunk
 * checkpoint reports - a member whose chunks cannot honor the chunk policy a lake REQUIRES - and
 * refuses the MEMBERSHIP WRITE rather than admitting content that will never be retrievable.
 *
 * Two boundaries this deliberately does not cross, both settled in #1658:
 *
 * - **Admission, never eviction.** Only a NEW membership is refused. A file already in a lake keeps
 *   its membership and stays report-only; convergence for those is owner-triggered (#1681).
 * - **Never a query.** Lake health is advisory permanently (decision 8). Nothing here can block a
 *   read against a degraded lake - the measured harm was the product denying real capabilities, so
 *   degradation is told to the model, not refused to the user.
 *
 * Sequencing: report-only is the DEFAULT and the lever (`EnforceLakeAdmission`) resolves
 * platform -> org -> owner -> lake. Turning it on lights up existing lakes as inadmissible, which is
 * the intended outcome and must be visible in the #1666 health report before it is blocking.
 */

/**
 * The lake fields the contract is graded from: what it REQUIRES, plus the ownership the
 * enforcement lever resolves through. Deliberately a projection rather than `IDataLakeDocument`, so
 * the membership writes (which carry a `MembershipLake`, not a full document) can call this gate.
 */
export type AdmissionLake = Pick<
  IDataLakeDocument,
  'id' | 'name' | 'datalakeTag' | 'requiredPassageTokenTarget' | 'createdByUserId' | 'organizationId'
>;

/** A file whose lake membership is being written, as the gate sees it. */
export interface AdmissionMember {
  id?: string;
  /** The file's OWNER - chunk policy is owner-altitude (#1662), never the actor's. */
  userId: string;
  /**
   * The effective target this file's EXISTING chunks were built with (`FabFile.chunkedPassageTokenTarget`).
   * Authoritative when present: it is what the chunks ARE, not what policy says they would be. Absent
   * for a file that has not been chunked, where the gate predicts from the owner's chunk policy.
   */
  chunkedPassageTokenTarget?: number | null;
}

/** One lake requirement a member cannot honor, with the member that fails it. */
export interface InadmissibleMember {
  member: AdmissionMember;
  effectiveTarget: number;
  lake: FabFileChunkPolicyConflictLake;
}

export type AdmissionVerdict =
  | { status: 'admitted' }
  | { status: 'quarantined'; enforced: boolean; violations: InadmissibleMember[]; message: string };

/**
 * The admission decision, pure. A member is inadmissible to a lake when its effective chunk target
 * differs from that lake's effective required target - the SAME comparison
 * `recomputeFileChunkPolicyConflict` reports post-chunk, reused rather than restated so the gate and
 * the report can never disagree about what "cannot be honored" means.
 *
 * `enforced` only decides whether the caller throws; the verdict is computed identically either way,
 * so a report-only install logs exactly what an enforcing one would have refused.
 */
export function decideLakeAdmission(
  members: readonly { member: AdmissionMember; effectiveTarget: number }[],
  requirements: readonly FabFileChunkPolicyConflictLake[],
  enforcedLakeIds: ReadonlySet<string>
): AdmissionVerdict {
  const violations: InadmissibleMember[] = [];
  for (const { member, effectiveTarget } of members) {
    for (const lake of findViolatedLakeRequirements(effectiveTarget, [...requirements])) {
      violations.push({ member, effectiveTarget, lake });
    }
  }
  if (violations.length === 0) return { status: 'admitted' };

  const enforced = violations.some(v => isEnforced(v.lake, enforcedLakeIds));
  return { status: 'quarantined', enforced, violations, message: describeViolations(violations, enforcedLakeIds) };
}

/**
 * Whether this violated requirement can BLOCK. A requirement with no `lakeId` belongs to a
 * static-registry lake, which has no document and therefore no scope the `EnforceLakeAdmission`
 * lever could be resolved at - so it is reported and never enforced. Failing open here is the
 * correct direction: the alternative is refusing a write on a lever nobody could have set.
 */
const isEnforced = (lake: FabFileChunkPolicyConflictLake, enforcedLakeIds: ReadonlySet<string>): boolean =>
  !!lake.lakeId && enforcedLakeIds.has(lake.lakeId);

/**
 * The refusal a caller sees. Names the lake, the target it requires and the target the content
 * actually chunks at, because "rejected" without those three numbers leaves an owner with no move -
 * the fix is either the lake's `requiredPassageTokenTarget` or the owner's `DefaultChunkSize`, and
 * which one is theirs to choose.
 */
function describeViolations(violations: readonly InadmissibleMember[], enforcedLakeIds: ReadonlySet<string>): string {
  // When anything IS blocking, describe only that: naming lakes the caller was not actually
  // refused for turns an actionable error into a puzzle.
  const blocking = violations.filter(v => isEnforced(v.lake, enforcedLakeIds));
  const reported = blocking.length > 0 ? blocking : violations;
  const byLake = new Map<string, InadmissibleMember>();
  for (const violation of reported) {
    const key = violation.lake.lakeId ?? violation.lake.datalakeTag;
    if (!byLake.has(key)) byLake.set(key, violation);
  }

  const parts = [...byLake.values()].map(
    v =>
      `"${v.lake.name}" requires passages of ${v.lake.effectiveRequiredTarget} tokens, but this content ` +
      `chunks at ${v.effectiveTarget}`
  );
  const subject = reported.length === 1 ? 'This file cannot' : `${reported.length} files cannot`;
  return (
    `${subject} be added: ${parts.join('; ')}. Content that does not match a lake's passage policy is ` +
    `not retrievable from it. Change the lake's required passage size or the file owner's default ` +
    `chunk size, then try again.`
  );
}

/**
 * Only the two levels this gate emits. Structural rather than `Logger` because the membership write
 * paths carry a deliberately narrow logger (`{ warn? }`), and refusing their logger would cost the
 * report-only diagnostic at the busiest admission door there is. Everything downstream calls its
 * logger through `?.`, which is what makes a partial one safe.
 */
export interface AdmissionLogger {
  log?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
}

export interface LakeAdmissionAdapters {
  db: ScopedSettingsDb;
  /**
   * The model both sides' effective targets are clamped against; must be the one the chunker will
   * use. Resolved from the platform `defaultEmbeddingModel` setting when omitted, so a door does not
   * have to know it - and cannot pass one that disagrees with what chunking actually does.
   */
  embeddingModel?: string;
  logger?: AdmissionLogger;
}

/**
 * The settings resolver's parameter is typed as the concrete `Logger`, but every call it makes is
 * optional-chained (`logger?.warn?.()`), so a partial logger is safe there. One narrowing in one
 * place, rather than a cast at every door.
 */
const asResolverLogger = (logger: AdmissionLogger | undefined): Logger | undefined => logger as Logger | undefined;

/** Adapters with the embedding model settled, for the internals below. */
type ResolvedAdmissionAdapters = LakeAdmissionAdapters & { embeddingModel: string };

/**
 * Resolve each member's effective chunk target. A chunked file reports the target its chunks were
 * built with; an unchunked one is PREDICTED from its owner's `DefaultChunkSize` through the same
 * `effectiveChunkTokenLimit` clamp the chunker applies, which is what lets the gate refuse a bad
 * membership BEFORE the upload rather than after paying to embed it. One settings resolution per
 * distinct owner, not per file.
 */
async function resolveMemberTargets(
  members: readonly AdmissionMember[],
  { db, embeddingModel, logger }: ResolvedAdmissionAdapters
): Promise<{ member: AdmissionMember; effectiveTarget: number }[]> {
  const predictedByOwner = new Map<string, number>();
  const resolved: { member: AdmissionMember; effectiveTarget: number }[] = [];

  for (const member of members) {
    if (typeof member.chunkedPassageTokenTarget === 'number' && member.chunkedPassageTokenTarget > 0) {
      resolved.push({ member, effectiveTarget: member.chunkedPassageTokenTarget });
      continue;
    }
    let predicted = predictedByOwner.get(member.userId);
    if (predicted === undefined) {
      // FabFile carries no organizationId, so this is the owner rung over the platform base - the
      // same scope fabFileChunk.ts resolves before chunking, so the prediction matches what the
      // chunker will actually do. The resolver never throws; it degrades to the platform value.
      const policy = await resolveScopedSetting('DefaultChunkSize', scopeForFileOwner({ userId: member.userId }), db, {
        logger: asResolverLogger(logger),
      });
      const target =
        typeof policy.value === 'number' && Number.isFinite(policy.value) ? policy.value : DEFAULT_PASSAGE_TOKEN_TARGET;
      predicted = effectiveChunkTokenLimit({ model: embeddingModel, passageTokenTarget: target });
      predictedByOwner.set(member.userId, predicted);
    }
    resolved.push({ member, effectiveTarget: predicted });
  }

  return resolved;
}

/**
 * Which of these lakes enforce their contract right now. Resolved per lake through `scopeForLake`,
 * so one lake (or one org) can enforce while the rest of the install stays report-only - the
 * staged rollout the epic's "report-only before enforcing" rule requires.
 *
 * A resolution failure is NOT collapsed into "off": the resolver's contract is that it never throws
 * and degrades to the platform value, so an `off` here is a real `off`. Nothing swallows an error
 * into a permissive default.
 */
async function resolveEnforcingLakes(
  lakes: readonly AdmissionLake[],
  { db, logger }: Pick<LakeAdmissionAdapters, 'db' | 'logger'>
): Promise<Set<string>> {
  const enforcing = new Set<string>();
  for (const lake of lakes) {
    const resolved = await resolveScopedSetting('EnforceLakeAdmission', scopeForLake(lake), db, {
      logger: asResolverLogger(logger),
    });
    if (resolved.value === true) enforcing.add(lake.id);
  }
  return enforcing;
}

/**
 * Evaluate the admission contract for a membership write and REFUSE it when an affected lake
 * enforces. Report-only lakes get a logged verdict and the write proceeds unchanged.
 *
 * Does no settings work at all unless at least one target lake declares a
 * `requiredPassageTokenTarget` - the overwhelmingly common case is a lake with no explicit policy,
 * and "disabled" has to mean "does nothing", not "does everything and discards it".
 *
 * `members` empty means the files do not exist yet (the pre-upload doors), where the actor IS the
 * owner-to-be; callers pass `[{ userId: actor.userId }]` so the prediction runs against the right
 * chunk policy rather than being skipped.
 */
export async function assertLakeAdmission(
  lakes: readonly AdmissionLake[],
  members: readonly AdmissionMember[],
  adapters: LakeAdmissionAdapters
): Promise<AdmissionVerdict> {
  // Short-circuit before ANY read: no members, or no lake declaring a passage policy, means there
  // is no contract to grade. Checked on the raw lakes rather than on `buildLakeRequirements` so the
  // embedding-model resolution below is skipped too.
  const declaring = lakes.filter(
    lake => typeof lake.requiredPassageTokenTarget === 'number' && lake.requiredPassageTokenTarget > 0
  );
  if (declaring.length === 0 || members.length === 0) return { status: 'admitted' };

  const embeddingModel = adapters.embeddingModel ?? (await resolveDefaultEmbeddingModel(adapters));
  const resolved: ResolvedAdmissionAdapters = { ...adapters, embeddingModel };
  const requirements = buildLakeRequirements(declaring, embeddingModel);
  if (requirements.length === 0) return { status: 'admitted' };

  const [resolvedMembers, enforcingLakeIds] = await Promise.all([
    resolveMemberTargets(members, resolved),
    resolveEnforcingLakes(declaring, resolved),
  ]);

  const verdict = decideLakeAdmission(resolvedMembers, requirements, enforcingLakeIds);
  if (verdict.status === 'admitted') {
    // A satisfied contract is worth a line so a smoke test can tell "checked, admissible" from
    // "never checked" - the same reason recomputeFileChunkPolicyConflict logs its clean pass.
    adapters.logger?.log?.(
      `[admission] ${members.length} member(s) satisfy ${requirements.length} lake chunk requirement(s)`
    );
    return verdict;
  }

  adapters.logger?.warn?.(
    `[admission] ${verdict.violations.length} member/lake pair(s) violate the retrievability contract ` +
      `(${verdict.enforced ? 'ENFORCED - refusing the write' : 'report-only - allowing the write'}): ${verdict.message}`
  );
  if (verdict.enforced) throw new BadRequestError(verdict.message);
  return verdict;
}

/**
 * The embedding model the contract is graded against - the platform `defaultEmbeddingModel`, the
 * same row `fabFileChunk` reads before chunking. Resolved here rather than at each door so the two
 * sides of the comparison cannot be clamped against different windows.
 */
async function resolveDefaultEmbeddingModel({ db, logger }: LakeAdmissionAdapters): Promise<string> {
  const resolved = await resolveScopedSetting('defaultEmbeddingModel', {}, db, {
    logger: asResolverLogger(logger),
  });
  return resolved.value;
}
