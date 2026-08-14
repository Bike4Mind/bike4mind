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
import { CHARS_PER_TOKEN_SERVE_BOUND, deriveServeCharBudget } from './chunking';

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
  /** True when the char rollups are present, so P1/P2 and reachable chars are real numbers. */
  measured: boolean;
  status: {
    chunkWithinPolicy: PredicateStatus;
    chunkCountConsistent: PredicateStatus;
    fullyVectorized: PredicateStatus;
  };
  /** The subset of P1-P3 this member FAILS - the drill-down's "which predicate" list. */
  failed: LakeHealthPredicate[];
  /**
   * Characters of this file that can actually reach the model, or `null` when unmeasured.
   * `min(embeddedCharCount, embeddedChunkCount * serveCap)`: a chunk contributes its length only if
   * it is vector-bearing (else it is never retrieved) and only up to the serve cap (the rest is
   * clipped before the model sees it). Exact whenever the file's vector-bearing chunks are uniformly
   * within-cap or uniformly over-cap - which live data shows is >99.8% of files, since the chunker
   * packs to a uniform target. A file mixing both is the only approximation, and it always also
   * fails P1, so it is already surfaced.
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
  const measured = chunkedCharCount !== null && maxChunkCharLength !== null;

  // P1: the largest chunk must not exceed the policy size.
  const chunkWithinPolicy: PredicateStatus =
    maxChunkCharLength === null ? 'unknown' : maxChunkCharLength <= policy.policyChars ? 'pass' : 'fail';

  // P2: chunkCount must be at least what the document length implies at the policy size. This is what
  // catches the whole-document-in-one-chunk case without special-casing it.
  const expectedChunks = chunkedCharCount === null ? null : Math.ceil(chunkedCharCount / policy.policyChars);
  const chunkCountConsistent: PredicateStatus =
    expectedChunks === null ? 'unknown' : member.chunkCount >= expectedChunks ? 'pass' : 'fail';

  // P3: every chunk must carry a vector. `embeddedChunkCount` is the count of vector-bearing ROWS,
  // deliberately NOT `vectorizedChunkCount` (which also counts un-embeddable oversized chunks as done).
  const fullyVectorized: PredicateStatus =
    embeddedChunkCount === null ? 'unknown' : embeddedChunkCount >= member.chunkCount ? 'pass' : 'fail';

  const failed: LakeHealthPredicate[] = [];
  if (chunkWithinPolicy === 'fail') failed.push('chunkWithinPolicy');
  if (chunkCountConsistent === 'fail') failed.push('chunkCountConsistent');
  if (fullyVectorized === 'fail') failed.push('fullyVectorized');

  const reachableChars =
    embeddedCharCount === null || embeddedChunkCount === null
      ? null
      : Math.min(embeddedCharCount, embeddedChunkCount * policy.serveCap);

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
 */
export function summarizeLakeHealth(members: LakeHealthMemberInput[], policy: LakeHealthPolicy): LakeHealthReport {
  const withChunks = members.filter(m => m.chunkCount > 0);
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
