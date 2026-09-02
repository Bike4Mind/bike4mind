import type { LakeMembershipReport } from './lakeMembershipHealth';
/**
 * Derived data-lake health (#1666): the retrievability contract as four CHECKABLE predicates plus
 * one headline - "what share of the lake's content can actually reach the model". Health is
 * COMPUTED, not judged: every value here is a function of stored facts, so two people reading the
 * same lake get the same verdict.
 *
 * This module is deliberately PURE (no IO, no DB, no clock). It takes the per-file rollups a lake's
 * members already carry - `chunkCount`, `chunkedCharCount`, `maxChunkCharLength`, `embeddedChunkCount`,
 * `embeddedCharCount` - and turns them into predicate results. The rollups exist so lake health is an
 * aggregate over FILES, never a scan of the chunk collection: reading chunk rows to compute this was
 * measured as ruinous on a connector-fed lake (#1665), and one staging file already carries 13k chunks.
 * The load-bearing logic lives here, and only here, so it can be unit-tested against every transition
 * shape without a database.
 *
 * The unit is CHARACTERS (Unicode code points), because the serve cap is (#1661). `tokenCount` is not
 * a substitute: the chars-per-token ratio swings by corpus, so a customer-facing percentage derived
 * from it is systematically wrong per lake - the exact "vibe" these predicates exist to remove.
 */
import {
  CHARS_PER_TOKEN_SERVE_BOUND,
  type ChunkStallReason,
  deriveServeCharBudget,
  isChunkRebuildPending,
  isChunkStalled,
} from './chunking';

/** The four predicate keys, ordered as stated in #1666. Members name the ones they fail. */
export const LAKE_HEALTH_PREDICATES = [
  'chunkWithinPolicy', // P1: no chunk exceeds the lake's policy size
  'chunkCountConsistent', // P2: chunkCount is consistent with document length over policy size
  'fullyVectorized', // P3: vector-bearing chunk rows >= chunkCount
  'serveCapMeetsPolicy', // P4: the effective serve cap is >= the policy size
] as const;
export type LakeHealthPredicate = (typeof LAKE_HEALTH_PREDICATES)[number];

/**
 * A predicate is `pass`/`fail` only when the data it needs has been measured; `unknown` means the
 * inputs are absent (the #1665 char-length backfill has not reached this file yet), NOT that the
 * predicate holds. Collapsing `unknown` into `pass` would report a lake healthy for content nothing
 * has looked at - the precise failure mode this feature exists to catch.
 */
export type PredicateStatus = 'pass' | 'fail' | 'unknown';

/**
 * The chunk-policy budget a lake's health is evaluated against, all derived from ONE token target so
 * the numbers cannot disagree (#1661). The target itself is resolved at file-owner altitude (#1662);
 * per epic decision 5 a lake's policy is `explicit` (its own `requiredPassageTokenTarget`) or
 * `inherited` (the platform/owner `DefaultChunkSize`), and health is reported for both.
 */
export type LakeHealthPolicy = {
  /** Effective passage token target after the chunker's own min/floor clamp. */
  chunkTokenTarget: number;
  /** Whether the target is the lake's explicit requirement or the inherited default (decision 5). */
  source: 'explicit' | 'inherited';
  /** Characters one in-policy chunk should hold: `chunkTokenTarget * CHARS_PER_TOKEN_SERVE_BOUND`. */
  policyChars: number;
  /** Characters of one chunk the serve path emits before it clips (`deriveServeCharBudget.maxChunkChars`). */
  serveCap: number;
  /** P4 fails exactly here: the serve ceiling left the cap BELOW the policy size (`ceilingBound`). */
  serveCapBelowPolicy: boolean;
};

/**
 * Resolve the policy a lake is graded against. `explicitTarget` is the lake's
 * `requiredPassageTokenTarget`; `inheritedTarget` is the resolved scoped `DefaultChunkSize`. An
 * explicit target of `<= 0`/null/undefined is treated as "no explicit policy" and falls back to
 * inherited, matching how the chunker itself reads an unusable target.
 */
export function resolveLakeHealthPolicy(opts: {
  explicitTarget?: number | null;
  inheritedTarget: number;
}): LakeHealthPolicy {
  const hasExplicit =
    typeof opts.explicitTarget === 'number' && Number.isFinite(opts.explicitTarget) && opts.explicitTarget > 0;
  const rawTarget = hasExplicit ? (opts.explicitTarget as number) : opts.inheritedTarget;
  const budget = deriveServeCharBudget(rawTarget);
  return {
    chunkTokenTarget: budget.chunkTokenTarget,
    source: hasExplicit ? 'explicit' : 'inherited',
    policyChars: budget.chunkTokenTarget * CHARS_PER_TOKEN_SERVE_BOUND,
    serveCap: budget.maxChunkChars,
    serveCapBelowPolicy: budget.ceilingBound,
  };
}

/**
 * The per-file rollups health reads. A `null`/`undefined` char field means UNMEASURED (the backfill
 * has not reached this file), which is distinct from `0`. `embeddedChunkCount` is measurable from
 * vector presence alone, so P3 can be graded before the char-length backfill runs; the char fields
 * gate P1/P2 and the reachable headline.
 */
export type LakeHealthMemberInput = {
  fabFileId: string;
  fileName?: string;
  /** Chunks created for the file (`FabFile.chunkCount`). */
  chunkCount: number;
  /**
   * Terminal (has-vector OR oversized-unembeddable) chunk rows, `FabFile.vectorizedChunkCount`. Used
   * only to tell "still indexing" from "settled": while it is below `chunkCount` the file is mid-
   * vectorization, so P3 and reachability are PENDING rather than failing. `null`/absent (predates
   * the field) is treated as settled so legacy files keep grading. Distinct from `embeddedChunkCount`,
   * which counts ONLY vector-bearing rows and is what P3 itself grades.
   */
  vectorizedChunkCount?: number | null;
  /**
   * Terminal vectorization-failure marker (`FabFile.error`). A permanently-failed file never reaches
   * `vectorizedChunkCount >= chunkCount`, so without this it would read as "still indexing" forever
   * and drop out of BOTH sides of the reachable ratio - a lake where every file failed would then
   * report "not measured" instead of unhealthy, the exact green-counters-but-broken mode this feature
   * exists to catch. A file carrying an error is treated as SETTLED, so it fails P3 and contributes
   * its real (0/partial) reachable figure. `isVectorizing` cannot serve as this signal: chunk-complete
   * clears it before vectorization even starts (chunk.ts).
   */
  error?: string | null;
  /**
   * `FabFile.chunkStallReason`. The second class of permanently-stalled file: the convergence kill
   * switch abandons a vectorize by stamping this and clearing `isVectorizing`, and it never sets
   * `error`, so without this the file satisfies none of the settled arms and hides from BOTH sides of
   * the reachable ratio forever - the same green-counters-but-broken mode `error` exists to catch,
   * reached by a different route. The handler's own log states these do not auto-resume, so this is
   * durable, not a window.
   */
  chunkStallReason?: ChunkStallReason | null;
  /**
   * `FabFile.chunkRebuildRequestedAt` (#1939): a passage rebuild was requested and has not committed.
   * The THIRD not-a-plain-zero signal, and the only one that fires on a member with no marker of any
   * kind - the reset that stamps it clears the stall reason, leaves `error` null and zeroes both
   * counts, so the member is otherwise shaped exactly like an image. Read as STILL INDEXING, never as a
   * failure: the file is mid-rebuild by definition, and grading it as a settled zero would flash
   * every ordinary reprocess red. It is admitted to the member set (see `summarizeLakeHealth`) so it
   * shows up as unmeasured coverage rather than disappearing from the lake entirely.
   */
  chunkRebuildRequestedAt?: Date | string | null;
  /** Sum of the file's chunks' `charLength`; `null` until measured. */
  chunkedCharCount?: number | null;
  /** Largest single chunk's `charLength`; `null` until measured. */
  maxChunkCharLength?: number | null;
  /** Count of chunk rows that carry a vector; `null` until the rollup is computed. */
  embeddedChunkCount?: number | null;
  /** Sum of `charLength` over vector-bearing chunks; `null` until measured. */
  embeddedCharCount?: number | null;
};

export type LakeHealthMemberResult = {
  fabFileId: string;
  fileName?: string;
  chunkCount: number;
  /**
   * True when this file contributes a REAL reachable figure to the headline: its char and vector
   * rollups are present AND its vectorization has settled. A file still being indexed is `false`
   * (pending), NOT measured-as-zero - counting it would drag a lake to 0% mid-ingest.
   */
  measured: boolean;
  status: {
    chunkWithinPolicy: PredicateStatus;
    chunkCountConsistent: PredicateStatus;
    fullyVectorized: PredicateStatus;
  };
  /** The subset of P1-P3 this member FAILS - the drill-down's "which predicate" list. */
  failed: LakeHealthPredicate[];
  /**
   * Characters of this file that can actually reach the model, or `null` when unmeasured/pending.
   * `min(embeddedCharCount, embeddedChunkCount * serveCap)`: a chunk contributes its length only if
   * it is vector-bearing (else it is never retrieved) and only up to the serve cap (the rest is
   * clipped before the model sees it). Exact whenever the file's vector-bearing chunks are uniformly
   * within-cap or uniformly over-cap - which live data shows is >99.8% of files, since the chunker
   * packs to a uniform target. A file mixing both is the only approximation, and its direction is
   * always an OVER-estimate (the file reads healthier than reality, never worse) because
   * `min(sum, n * cap) >= sum(min(len_i, cap))`; such a file also always fails P1, so it is
   * surfaced anyway.
   */
  reachableChars: number | null;
  /** Denominator contribution: the file's measured chunked characters, or `null` when unmeasured. */
  chunkedChars: number | null;
};

/** Grade one member against the policy. Pure; `chunkCount === 0` members are the caller's to exclude. */
export function evaluateMemberHealth(member: LakeHealthMemberInput, policy: LakeHealthPolicy): LakeHealthMemberResult {
  const chunkedCharCount = nonNegOrNull(member.chunkedCharCount);
  const maxChunkCharLength = nonNegOrNull(member.maxChunkCharLength);
  const embeddedCharCount = nonNegOrNull(member.embeddedCharCount);
  const embeddedChunkCount = nonNegOrNull(member.embeddedChunkCount);
  const vectorizedChunkCount = nonNegOrNull(member.vectorizedChunkCount);
  const hasError = typeof member.error === 'string' && member.error.length > 0;
  // The kill switch marks an abandoned vectorize with `chunkStallReason` and never with `error`, so
  // this is the second terminal-stall signal, not a redundant one. See
  // LakeHealthMemberInput.chunkStallReason.
  //
  // Correct WITHOUT a `chunkCount` guard of its own, but only because `commitFabFileChunks` clears
  // the reason in the same transaction as the chunks it writes. Without that clear, a file the
  // RESCUE SWEEP had already rebuilt would still carry the reason while legitimately mid-vectorize,
  // be forced to settled here, and fail P3 on its real ratio - a normal rebuild flashing red, this
  // block's own failure mode reached by another route. The clear is transactional, so it cannot be
  // lost while the rebuild it describes lands; if it is ever made best-effort, this needs the guard
  // `passagesRemoved` uses below.
  const abandonedByKillSwitch = isChunkStalled(member.chunkStallReason);
  // The CHUNK arm of the same switch, and the one case where absent rollups are not "unmeasured".
  // `resetChunkStateByIds` nulls all four rollups in the write that deletes the file's passages, so
  // every predicate below would abstain on `null` and the member would grade `unknown` across the
  // board - excluded from `failed`, excluded from `reachableChars`, and therefore invisible in both
  // the drill-down and the headline. That is precisely the reading this module exists to catch, so
  // the missing rollups are read as the PROVEN zero they are: no passages means no vector-bearing
  // chunk and no reachable character. `chunkCount === 0` is required, not decorative - the marker
  // outlives a rebuild the RESCUE SWEEP performs (that path enqueues without a reset), so keying on
  // the reason alone would fail a repaired file forever.
  // Same guard, same reason, as `decideMemberConvergence`'s own arm.
  const passagesRemoved = member.chunkCount === 0 && member.chunkStallReason === 'rechunkPaused';
  // A rebuild that was REQUESTED and has not committed (#1939). Deliberately NOT folded into
  // `passagesRemoved`: the passages are equally gone, but this one is expected back, so forcing P3
  // to `fail` here would make every ordinary "Rebuild passages" wave and every per-file reprocess
  // paint its lake red for the length of the rebuild - the cries-wolf failure this whole feature is
  // built to avoid. Ranked below the two settled markers for the same reason as in
  // `isMemberIndexingInFlight`: a stamp that outlives a rebuild which failed or was halted describes
  // a rebuild that stopped, not one still running.
  const rebuildPending = !hasError && !abandonedByKillSwitch && isChunkRebuildPending(member.chunkRebuildRequestedAt);

  // Is the file's vectorization settled, or is it still being indexed? chunk-complete stamps the char
  // rollups (making the file "measured") and zeroes the vector rollups in the SAME write, so between
  // chunk-complete and the first vectorize batch a file would otherwise read as measured-but-0%-
  // reachable and fail P3 - a normal upload flashing red. `vectorizedChunkCount >= chunkCount` mirrors
  // the vectorize handler's own completion gate (terminal = has-vector OR oversized); a settled-but-
  // under-vectorized file (an un-embeddable oversized chunk reaches terminal) still fails P3 as it
  // should. A permanently-FAILED file (`error` set) is also settled - it will never reach the terminal
  // count, but it is broken, not in flight, so it must grade (fail P3, count its real reachable chars)
  // rather than hide. A null count predates the field, so treat it as settled to keep legacy files grading.
  // Mirrors `isMemberIndexingInFlight` (lakeConvergence.ts) arm for arm, including the pending-rebuild
  // one, so health, convergence and the retrieval withhold cannot disagree about what "still
  // indexing" means. Keep the two in step.
  const vectorizationSettled =
    !rebuildPending &&
    (hasError || abandonedByKillSwitch || vectorizedChunkCount === null || vectorizedChunkCount >= member.chunkCount);

  // P1: the largest chunk must not exceed the policy size. Graded as soon as the chunk rollups exist
  // (even mid-vectorize): an oversized chunk is a structural fact, not a timing artifact.
  const chunkWithinPolicy: PredicateStatus =
    maxChunkCharLength === null ? 'unknown' : maxChunkCharLength <= policy.policyChars ? 'pass' : 'fail';

  // P2: chunkCount must be at least what the CHUNKED length implies at the policy size - catches the
  // whole-document-in-one-chunk case without special-casing. Note the denominator is the sum of the
  // chunks' own lengths, so as implemented P2 is a corollary of P1 (it cannot fail unless some chunk
  // already exceeds the policy size); it is kept as a distinct, separately-reported signal. The
  // document-length counterpart is `extractedCharCount`, which a different extractor writes lazily and
  // which the codebase explicitly warns must not be conflated with `chunkedCharCount`.
  const expectedChunks = chunkedCharCount === null ? null : Math.ceil(chunkedCharCount / policy.policyChars);
  const chunkCountConsistent: PredicateStatus =
    expectedChunks === null ? 'unknown' : member.chunkCount >= expectedChunks ? 'pass' : 'fail';

  // P3: every chunk must carry a vector. `embeddedChunkCount` is the count of vector-bearing ROWS,
  // deliberately NOT `vectorizedChunkCount` (which also counts un-embeddable oversized chunks as done).
  // While vectorization is still in flight the answer is genuinely PENDING, not a failure.
  const fullyVectorized: PredicateStatus = passagesRemoved
    ? 'fail'
    : !vectorizationSettled
      ? 'unknown'
      : embeddedChunkCount === null
        ? 'unknown'
        : embeddedChunkCount >= member.chunkCount
          ? 'pass'
          : 'fail';

  const failed: LakeHealthPredicate[] = [];
  if (chunkWithinPolicy === 'fail') failed.push('chunkWithinPolicy');
  if (chunkCountConsistent === 'fail') failed.push('chunkCountConsistent');
  if (fullyVectorized === 'fail') failed.push('fullyVectorized');

  // Reachability is a real number only once the char and vector rollups are present AND vectorization
  // has settled; otherwise it is pending (null), so the summarizer excludes it from BOTH the numerator
  // and the denominator rather than counting it as zero-reachable.
  const reachableChars = passagesRemoved
    ? 0
    : !vectorizationSettled || chunkedCharCount === null || embeddedCharCount === null || embeddedChunkCount === null
      ? null
      : Math.min(embeddedCharCount, embeddedChunkCount * policy.serveCap);
  const measured = reachableChars !== null;

  return {
    fabFileId: member.fabFileId,
    fileName: member.fileName,
    chunkCount: member.chunkCount,
    measured,
    status: { chunkWithinPolicy, chunkCountConsistent, fullyVectorized },
    failed,
    reachableChars,
    chunkedChars: chunkedCharCount,
  };
}

/** Per-predicate tally across a lake's members. P1-P3 are per-file; P4 is the lake-level policy fact. */
export type PredicateTally = { pass: number; fail: number; unknown: number };

export type LakeHealthReport = {
  policy: LakeHealthPolicy;
  predicates: {
    chunkWithinPolicy: PredicateTally;
    chunkCountConsistent: PredicateTally;
    fullyVectorized: PredicateTally;
    /** Lake-level: `pass` unless the serve cap is below the policy size (P4). */
    serveCapMeetsPolicy: PredicateStatus;
  };
  /**
   * The headline: share of MEASURED chunked content that can reach the model, in [0,1], or `null`
   * when no member is measured yet (so the UI shows "not yet measured" rather than a false 0%).
   */
  reachableShare: number | null;
  reachableChars: number;
  /** Denominator behind `reachableShare`: measured chunked characters. */
  measuredChunkedChars: number;
  /** How complete the picture is: measured members over members-with-chunks. `1` = fully measured. */
  coverage: { measuredMembers: number; membersWithChunks: number };
  /** Members failing at least one of P1-P3, worst first, for the drill-down. */
  affectedMembers: LakeHealthMemberResult[];
};

/**
 * Aggregate per-member results into a lake report. `chunkCount === 0` members (images, still-pending
 * uploads) are excluded: they carry no retrievable content and would otherwise dilute every ratio.
 *
 * With ONE exception, and it is the case this report exists for: a member the convergence kill
 * switch stalled mid-wave is also chunkless, but because its passages were DELETED, not because it
 * never had any. Excluding it produced the exact green-counters-but-broken reading the four rules
 * are meant to catch - a lake reporting "Reachable 100%" over the members it still had, while a
 * document sat entirely unsearchable and absent from `affectedMembers`. Admitting it here is only
 * half the fix and was, on its own, inert: the same reset nulls all four rollups, so every
 * predicate abstained and the member landed in neither `failed` nor the ratio. `evaluateMemberHealth`
 * reads that marker as the proven zero it is (see `passagesRemoved` there), which is what actually
 * fails P3 and names it in the drill-down.
 *
 * Note what this does NOT do: `reachableShare` cannot move for such a member, because the reset
 * destroyed the `chunkedCharCount` that would have been its denominator - it contributes 0/0. The
 * signal is the P3 `fail` tally and the drill-down row, which is what `deriveLakeHealthBadge` reads
 * to drop the lake off `healthy` regardless of the percentage beside it.
 */
export function summarizeLakeHealth(members: LakeHealthMemberInput[], policy: LakeHealthPolicy): LakeHealthReport {
  // The CHUNK arm only, matching `findDataLakeHealthMembers`'s own `$match` and
  // `partitionByIndexAvailability`: the vectorize arm of the switch leaves chunks in place, so it is
  // already admitted by `chunkCount > 0` and needs no exception here.
  //
  // The pending-rebuild stamp (#1939) is admitted for the same reason as the marker and with the
  // opposite grade: chunkless because a wave took its passages, but expected back, so it lands in
  // `coverage` as an unmeasured member rather than in the ratio. Coverage below 1 is the honest
  // report while a rebuild is running - and it is also what keeps a rebuild that was never enqueued
  // visible instead of silently reducing the lake to the members it still has.
  const withChunks = members.filter(
    m => m.chunkCount > 0 || m.chunkStallReason === 'rechunkPaused' || isChunkRebuildPending(m.chunkRebuildRequestedAt)
  );
  const results = withChunks.map(m => evaluateMemberHealth(m, policy));

  const predicates = {
    chunkWithinPolicy: emptyTally(),
    chunkCountConsistent: emptyTally(),
    fullyVectorized: emptyTally(),
    serveCapMeetsPolicy: (policy.serveCapBelowPolicy ? 'fail' : 'pass') as PredicateStatus,
  };
  let reachableChars = 0;
  let measuredChunkedChars = 0;
  let measuredMembers = 0;
  for (const r of results) {
    tally(predicates.chunkWithinPolicy, r.status.chunkWithinPolicy);
    tally(predicates.chunkCountConsistent, r.status.chunkCountConsistent);
    tally(predicates.fullyVectorized, r.status.fullyVectorized);
    if (r.measured) {
      measuredMembers += 1;
      measuredChunkedChars += r.chunkedChars ?? 0;
      reachableChars += r.reachableChars ?? 0;
    }
  }

  const affectedMembers = results
    .filter(r => r.failed.length > 0)
    // Worst first: more failing predicates, then less reachable, so the drill-down leads with the
    // members that hurt the lake most.
    .sort((a, b) => b.failed.length - a.failed.length || (a.reachableChars ?? 0) - (b.reachableChars ?? 0));

  return {
    policy,
    predicates,
    reachableShare: measuredChunkedChars > 0 ? reachableChars / measuredChunkedChars : null,
    reachableChars,
    measuredChunkedChars,
    coverage: { measuredMembers, membersWithChunks: results.length },
    affectedMembers,
  };
}

/**
 * The shape GET /api/data-lakes/:id/health returns - the report with its drill-down list capped and
 * an exact count beside it, plus a scan-bound flag. Defined here so the handler, the service and the
 * client hook share ONE contract.
 */
export type LakeHealthApiResponse = Omit<LakeHealthReport, 'affectedMembers'> & {
  /** Failing members for the drill-down, worst-first, capped for payload size. */
  affectedMembers: LakeHealthMemberResult[];
  /** Total failing members even when `affectedMembers` is capped, so the UI never implies fewer. */
  affectedMemberCount: number;
  /** True when the lake exceeded the member scan bound, so every ratio here is partial. */
  scanTruncated: boolean;
  /**
   * The MEMBERSHIP dimension (#2245): who is in this lake and whether any document is here twice.
   * Separate from the predicates above because every one of them can pass on a lake carrying two
   * upload generations of the same files - each generation genuinely is chunked and vectorized.
   */
  membership: LakeMembershipReport;
};

function emptyTally(): PredicateTally {
  return { pass: 0, fail: 0, unknown: 0 };
}
function tally(t: PredicateTally, status: PredicateStatus): void {
  t[status] += 1;
}
/** Treat only a finite, non-negative number as measured; everything else (null, undefined, NaN) is unmeasured. */
function nonNegOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
