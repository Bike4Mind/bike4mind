/**
 * Owner-triggered convergence toward a lake's declared chunk policy (#1681).
 *
 * The decision half of convergence, and deliberately the whole of it that can be reasoned about:
 * this module is PURE (no IO, no DB, no clock), so "which members does this lake rewrite, and which
 * does it refuse" is unit-testable across every transition shape. The service layer around it does
 * the reads, the cross-lake check that needs a DB, and the enqueue.
 *
 * Three rules shape everything here:
 *
 * 1. **Only an EXPLICIT policy converges** (epic decision 5). A lake on the `inherited` platform
 *    default is measured and reported by health, never repaired - otherwise changing a platform
 *    default would silently re-embed every lake in the install. The lake-level gate lives in
 *    `isConvergeablePolicy`; nothing below it is reachable without one.
 *
 * 2. **Rewrite only what is PROVABLY non-conformant.** A member converges when a measured fact says
 *    it violates the policy - its stamped chunk target differs, or its largest chunk is over the
 *    policy size. A member with neither fact measured is `unmeasured`, NOT conformant: collapsing
 *    "we could not tell" into "it is fine" is how a lake reports healthy for content nothing has
 *    looked at, and collapsing it into "rewrite it" is how a backfill gap turns into a full-lake
 *    re-embed. It is reported and left alone.
 *
 * 3. **Refuse rather than degrade.** The re-chunk is a delete-and-reinsert whose new rows carry no
 *    vector, and the search read path filters on `vector: {$exists: true, $ne: []}` - so a member is
 *    invisible to semantic search from commit until its LAST chunk embeds, and the old vectors are
 *    already gone. "Serve stale" is not available. Every refusal here is a member the caller must
 *    report, never one it may quietly drop.
 */
import { isChunkRebuildPending, isConvergencePausedNote } from './chunking';

/**
 * Why a member of a convergeable lake was NOT rewritten. Every skipped member lands in exactly one
 * of these, and the plan carries the tally, so "nothing converged" is always explainable.
 */
export const CONVERGENCE_SKIP_REASONS = [
  /** Its chunks already satisfy the policy. The steady state. */
  'conformant',
  /**
   * Neither its stamped chunk target nor its largest chunk length has been measured, so nothing
   * proves it violates the policy. Reported so a stalled #1665 backfill is visible as a coverage
   * gap rather than as a healthy lake.
   */
  'unmeasured',
  /**
   * Its vectorization has not settled. Re-chunking now would discard embedding spend already in
   * flight and extend the window in which the member is unsearchable, so convergence waits for the
   * current pass instead of racing it.
   */
  'indexingInFlight',
  /**
   * A prior chunk or vectorize attempt failed terminally (`error` set). Re-enqueuing it converges
   * nothing and re-pays for the same deterministic failure; surfaced so an owner can tell "lake is
   * converged" from "these members gave up".
   */
  'previouslyFailed',
  /**
   * Its chunks were already built at the policy's target and STILL exceed the policy's character
   * budget - so a rewrite would reproduce them exactly. See `decideMemberConvergence`'s fourth arm
   * for why this is a terminal state rather than a violation: the budget is in characters and the
   * chunker is bounded in tokens, so this predicate is not one a re-chunk can be asked to satisfy.
   * Reported, never repaired - the fix is an operator lowering the target or the chunker gaining a
   * character bound, neither of which convergence can do on its own.
   */
  'irreducibleOvershoot',
] as const;
export type ConvergenceSkipReason = (typeof CONVERGENCE_SKIP_REASONS)[number];

/**
 * The policy a lake converges toward. Both targets are carried because they answer different
 * questions and conflating them is a real bug: `requiredTarget` is what a chunk job is ASKED for
 * (the chunker applies its own model-window clamp), while `effectiveRequiredTarget` is the
 * post-clamp value a file's stamped `chunkedPassageTokenTarget` must be compared against. Two
 * configured targets that both exceed the model window clamp to the same limit and must NOT read as
 * a violation - the same like-for-like rule `findViolatedLakeRequirements` (#1662) applies.
 */
export type LakeConvergencePolicy = {
  /** The lake's operator-set `requiredPassageTokenTarget`, in tokens. */
  requiredTarget: number;
  /** `requiredTarget` after the embedding model's window clamp, in tokens. */
  effectiveRequiredTarget: number;
  /** Characters one in-policy chunk should hold (`LakeHealthPolicy.policyChars`). */
  policyChars: number;
};

/**
 * The per-member facts convergence decides on - a subset of the FabFile rollups health already
 * reads (#1665/#1666), plus the owner id needed to re-enqueue the member's chunk job and the
 * chunk target #1662 stamps. A `null` char/target field means UNMEASURED, distinct from `0`.
 */
export type ConvergenceMemberInput = {
  fabFileId: string;
  /** The file's owner, threaded into the chunk message; convergence is system-executed for them. */
  userId: string;
  fileName?: string;
  chunkCount: number;
  /** Terminal (embedded or unembeddable) chunk rows; below `chunkCount` means still indexing. */
  vectorizedChunkCount?: number | null;
  error?: string | null;
  /** Read only to detect `CONVERGENCE_PAUSED_NOTE` - see `isMemberIndexingInFlight`. */
  notes?: string | null;
  /** Set while a passage rebuild is outstanding (#1939) - see `isMemberIndexingInFlight`. */
  chunkRebuildRequestedAt?: Date | string | null;
  /** Largest chunk's `charLength`; `null` until the #1665 backfill reaches the file. */
  maxChunkCharLength?: number | null;
  /** Effective chunk target the file's chunks were built at (#1662); `null` on legacy files. */
  chunkedPassageTokenTarget?: number | null;
};

/** A member convergence will rewrite, with the ordering key that puts the worst offenders first. */
export type ConvergenceCandidate = {
  fabFileId: string;
  userId: string;
  fileName?: string;
  /**
   * Characters the largest chunk exceeds the policy size by, or `0` when the violation is a target
   * mismatch with no measured overshoot. Sorts the wave worst-first: the members losing the most
   * content to the serve cap are repaired before the marginal ones.
   */
  overshootChars: number;
  /**
   * This member has NO passages at all - a wave deleted them and the kill switch halted the rebuild.
   * Outranks `overshootChars` in the wave order: an oversized chunk still returns something, this
   * returns nothing, and `overshootChars` is 0 here (there is no chunk to measure), which would
   * otherwise sort the lake's most damaged members last.
   */
  passagesRemoved?: boolean;
};

export type ConvergenceMemberDecision =
  ({ converge: true } & ConvergenceCandidate) | { converge: false; fabFileId: string; reason: ConvergenceSkipReason };

export type LakeConvergencePlan = {
  /** Members to rewrite, worst-first. */
  candidates: ConvergenceCandidate[];
  /** Every member that was not selected, by reason. Keys are exhaustive over the reason union. */
  skipped: Record<ConvergenceSkipReason, number>;
  /** Members graded - the denominator behind `changeShare`. */
  membersConsidered: number;
  /** `candidates.length / membersConsidered`, in [0,1]; `0` for a lake with no gradable members. */
  changeShare: number;
};

/**
 * Below this many gradable members a share is not a meaningful signal - 1 of 2 files is 50% and
 * means nothing - so the bulk-change guard does not fire. A definitional floor for the percentage,
 * not an operational lever: the lever is the share threshold itself.
 */
export const BULK_CHANGE_MIN_MEMBERS = 10;

/**
 * Default for the `LakeConvergenceBulkChangeSharePct` lever, as a PERCENT. Lives here so the
 * settings schema that declares the lever and the resolver that falls back when it is unset read
 * ONE number - two literals would drift the day someone tunes the default in only one of them.
 *
 * 25% is well above the drift a healthy lake accumulates and well below the share a genuine policy
 * change produces, so the guard is quiet in normal operation and loud on the case it exists for.
 */
export const BULK_CHANGE_SHARE_PCT_DEFAULT = 25;

/**
 * Whether a lake's policy is one convergence may act on (epic decision 5). `inherited` lakes are
 * measured and reported by health, never repaired. The service gates on this BEFORE reading any
 * member, so a lake with no explicit policy costs one lake document and nothing else.
 */
export function isConvergeablePolicy(policy: { source: 'explicit' | 'inherited' }): boolean {
  return policy.source === 'explicit';
}

/**
 * Whether a member's vectorization is still in flight, mirroring `evaluateMemberHealth`'s own
 * settled test so convergence, health and retrieval cannot disagree about what "still indexing"
 * means. A file carrying an error, or abandoned by the convergence kill switch (which writes
 * `CONVERGENCE_PAUSED_NOTE` and never sets `error`), is SETTLED - permanently stalled, not in
 * flight - and is classified by its own reason instead of hiding here forever.
 *
 * Exported because the RETRIEVAL path needs the same predicate, for the constraint that shapes this
 * whole feature: a re-chunk deletes the old chunk rows and reinserts rows carrying NO vector, and
 * the search read path filters `vector: {$exists: true, $ne: []}` - so from the moment the rewrite
 * commits until the member's LAST chunk embeds, it is invisible to semantic search and its previous
 * vectors are already gone. "Serve stale" is not available. A member in this state must be REFUSED
 * and reported, never silently allowed to contribute nothing while its neighbours are re-ranked
 * into the top-K to produce a confident wrong answer.
 */
export function isMemberIndexingInFlight(member: {
  chunkCount: number;
  vectorizedChunkCount?: number | null;
  error?: string | null;
  notes?: string | null;
  chunkRebuildRequestedAt?: Date | string | null;
}): boolean {
  const settledByFailure = typeof member.error === 'string' && member.error.length > 0;
  const settledByKillSwitch = isConvergencePausedNote(member.notes);
  if (settledByFailure || settledByKillSwitch) return false;
  // A REQUESTED-but-uncommitted rebuild (#1939) is in flight by the same argument as an unfinished
  // vectorize, and it is the only arm that can fire on a CHUNKLESS member: the reset that stamps it
  // zeroes `chunkCount` and `vectorizedChunkCount` together, so the count comparison below reads
  // 0 < 0 and would call it settled. Checked AFTER the two settled arms deliberately - `error` and
  // the paused note both describe a rebuild that has STOPPED, and a stopped rebuild whose stamp was
  // never cleared must not read as one still running.
  if (isChunkRebuildPending(member.chunkRebuildRequestedAt)) return true;
  // A null count predates the field; treat it as settled so legacy files stay gradable.
  return typeof member.vectorizedChunkCount === 'number' && member.vectorizedChunkCount < member.chunkCount;
}

/** Only a finite, positive number counts as measured; null, undefined, 0 and NaN do not. */
function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Grade one member against the policy. The load-bearing decision: everything convergence spends
 * money on flows from this returning `converge: true`.
 *
 * Order matters and is not arbitrary - each earlier arm describes a member the later arms cannot
 * judge honestly:
 *   1. terminally failed  - re-enqueuing buys a repeat of the same failure;
 *   2. still indexing     - its rollups describe chunks that are mid-replacement already;
 *   3. unmeasured         - no fact proves a violation, so refuse rather than guess either way;
 *   4. proven violation   - stamped target differs, or the largest chunk is over the policy size;
 *   5. otherwise          - conformant.
 *
 * Arm 4 carries the one non-obvious restriction here, and it is what stops this module from
 * spending money forever. The two violations it accepts are NOT equally satisfiable:
 *
 *  - The TARGET arm is satisfiable by construction. The run asks for `requiredTarget`, the handler
 *    stamps `effectiveChunkTokenLimit` of it, and this function compares against the same clamp of
 *    the same value - so one successful pass ends it.
 *  - The OVERSHOOT arm is not. `policyChars` is a CHARACTER budget derived from the token target by
 *    an upper-bound estimate (`CHARS_PER_TOKEN_SERVE_BOUND`), while `SmartChunker` is bounded in
 *    TOKENS only - nothing anywhere enforces a character limit. Text that beats the estimate exists
 *    and is ordinary (long whitespace runs and padded tables tokenize far denser than the bound
 *    assumes - see `constants/chunking.ts`), and `maxChunkCharLength` is a MAX over the file's
 *    chunks, so a single such chunk condemns the whole file.
 *
 * So an overshoot that survives a rewrite AT the policy's own target is a fact about the chunker,
 * not drift: the same input at the same target deterministically produces the same chunks. Left
 * OR'd with the target arm it would return `converge: true` on identical inputs on every wave, with
 * no attempt counter and no `error` to catch it - re-tokenizing, deleting, reinserting and
 * re-embedding the file at full cost, forever. The stamp is the memory that breaks the loop: once
 * `chunkedPassageTokenTarget` equals the policy's effective target, an overshoot is terminal and
 * the member is reported as `irreducibleOvershoot` instead.
 *
 * This makes the stamp load-bearing for TERMINATION, not just for reporting - which is why
 * `commitFabFileChunks` writes it inside the same transaction as the chunks it describes.
 */
export function decideMemberConvergence(
  member: ConvergenceMemberInput,
  policy: LakeConvergencePolicy
): ConvergenceMemberDecision {
  const { fabFileId, userId, fileName } = member;

  if (typeof member.error === 'string' && member.error.length > 0) {
    return { converge: false, fabFileId, reason: 'previouslyFailed' };
  }
  if (isMemberIndexingInFlight(member)) {
    return { converge: false, fabFileId, reason: 'indexingInFlight' };
  }

  // Passages deleted, rebuild halted: the producer resets a wave's chunk state BEFORE the messages
  // are handled, so a member the kill switch stops has no chunks and no error. Graded HERE, ahead of
  // every arm below, because all of their facts are stale in exactly the way that hides it: the
  // reset preserves `chunkedPassageTokenTarget` but nulls `maxChunkCharLength`, so a member already
  // repaired to the policy before the halt reads as `conformant` and nothing ever rebuilds it - it
  // is simply absent from search, from health's denominator and from this plan at the same time.
  // A proven violation, and repairable by precisely the rewrite convergence performs.
  if (member.chunkCount === 0 && isConvergencePausedNote(member.notes)) {
    return { converge: true, fabFileId, userId, fileName, overshootChars: 0, passagesRemoved: true };
  }

  const stampedTarget = positiveOrNull(member.chunkedPassageTokenTarget);
  const maxChunkChars = positiveOrNull(member.maxChunkCharLength);
  if (stampedTarget === null && maxChunkChars === null) {
    return { converge: false, fabFileId, reason: 'unmeasured' };
  }

  const targetViolates = stampedTarget !== null && stampedTarget !== policy.effectiveRequiredTarget;
  const overshootChars = maxChunkChars !== null ? Math.max(0, maxChunkChars - policy.policyChars) : 0;
  if (!targetViolates && overshootChars === 0) {
    return { converge: false, fabFileId, reason: 'conformant' };
  }

  // Overshoot alone, on chunks already built at this policy's target: a rewrite is deterministic
  // and would land here again. Terminal, not a violation - see the arm-4 note above. A file with no
  // stamp at all is NOT caught here: nothing has yet proved a pass at this target happened, and its
  // one rewrite both repairs it and writes the stamp that decides it next time.
  if (!targetViolates && stampedTarget !== null) {
    return { converge: false, fabFileId, reason: 'irreducibleOvershoot' };
  }

  return { converge: true, fabFileId, userId, fileName, overshootChars };
}

/**
 * Grade every member and assemble the plan. Members with no chunks are excluded before grading -
 * an image or a still-pending upload carries no retrievable content, and counting them would
 * dilute `changeShare`, which the bulk-change guard reads.
 */
export function planLakeConvergence(
  members: ConvergenceMemberInput[],
  policy: LakeConvergencePolicy
): LakeConvergencePlan {
  // Chunkless members are excluded because an image or a pending upload carries no retrievable
  // content - but a member whose passages a HALTED WAVE removed is chunkless for the opposite
  // reason, and dropping it here is what let it vanish from every surface at once (it also leaves
  // health's denominator, which filters the same way). Kept, and graded as the violation it is.
  //
  // Same for a member with a rebuild outstanding (#1939): chunkless because a wave took its passages
  // and has not put them back yet. It grades `indexingInFlight`, not as a violation - the wave that
  // reset it is presumed to still be running - so it is REPORTED in the skip tally rather than
  // re-rewritten underneath a worker that is about to commit.
  const gradable = members.filter(
    m => m.chunkCount > 0 || isConvergencePausedNote(m.notes) || isChunkRebuildPending(m.chunkRebuildRequestedAt)
  );
  const skipped: Record<ConvergenceSkipReason, number> = {
    conformant: 0,
    unmeasured: 0,
    indexingInFlight: 0,
    previouslyFailed: 0,
    irreducibleOvershoot: 0,
  };
  const candidates: ConvergenceCandidate[] = [];

  for (const member of gradable) {
    const decision = decideMemberConvergence(member, policy);
    if (decision.converge) {
      candidates.push({
        fabFileId: decision.fabFileId,
        userId: decision.userId,
        fileName: decision.fileName,
        overshootChars: decision.overshootChars,
        passagesRemoved: decision.passagesRemoved,
      });
    } else {
      skipped[decision.reason] += 1;
    }
  }

  // Worst-first, then by id so a wave boundary is reproducible across two calls that see the same
  // lake - an owner running a second wave must get the NEXT members, not a reshuffle of the first.
  // Members with no passages at all lead, ahead of any overshoot: they return nothing today.
  candidates.sort(
    (a, b) =>
      Number(b.passagesRemoved ?? false) - Number(a.passagesRemoved ?? false) ||
      b.overshootChars - a.overshootChars ||
      (a.fabFileId < b.fabFileId ? -1 : 1)
  );

  return {
    candidates,
    skipped,
    membersConsidered: gradable.length,
    changeShare: gradable.length > 0 ? candidates.length / gradable.length : 0,
  };
}

/**
 * Constraint 4's guard: a run that would rewrite more than `shareThreshold` of a lake needs the
 * owner to confirm. A mass rewrite is the signature of a MISCONFIGURED POLICY, and every individual
 * change inside it looks locally reasonable - the share is the only place the mistake is visible.
 *
 * `shareThreshold` is a resolved operator lever, not a constant here; `BULK_CHANGE_MIN_MEMBERS`
 * suppresses the guard on lakes too small for a percentage to mean anything.
 */
export function requiresBulkChangeConfirmation(plan: LakeConvergencePlan, shareThreshold: number): boolean {
  if (plan.membersConsidered < BULK_CHANGE_MIN_MEMBERS) return false;
  if (plan.candidates.length === 0) return false;
  return plan.changeShare > shareThreshold;
}
