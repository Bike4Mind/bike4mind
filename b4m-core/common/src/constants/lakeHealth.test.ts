import { describe, it, expect } from 'vitest';
import { DEFAULT_PASSAGE_TOKEN_TARGET, CHARS_PER_TOKEN_SERVE_BOUND, SERVE_CHUNK_CHARS_CEILING } from './chunking';
import {
  resolveLakeHealthPolicy,
  evaluateMemberHealth,
  summarizeLakeHealth,
  type LakeHealthMemberInput,
} from './lakeHealth';
import { isMemberIndexingInFlight } from './lakeConvergence';

// Default policy: 512 tokens -> policyChars 3072, serveCap 3072, P4 pass.
const DEFAULT_POLICY = resolveLakeHealthPolicy({ inheritedTarget: DEFAULT_PASSAGE_TOKEN_TARGET });

const member = (over: Partial<LakeHealthMemberInput>): LakeHealthMemberInput => ({
  fabFileId: 'f1',
  chunkCount: 1,
  chunkedCharCount: 0,
  maxChunkCharLength: 0,
  embeddedChunkCount: 1,
  embeddedCharCount: 0,
  ...over,
});

describe('resolveLakeHealthPolicy', () => {
  it('derives policyChars and serveCap from the inherited default target', () => {
    expect(DEFAULT_POLICY).toEqual({
      chunkTokenTarget: 512,
      source: 'inherited',
      policyChars: 512 * CHARS_PER_TOKEN_SERVE_BOUND, // 3072
      serveCap: 3072,
      serveCapBelowPolicy: false,
    });
  });

  it('prefers an explicit lake target over the inherited default', () => {
    const p = resolveLakeHealthPolicy({ explicitTarget: 1000, inheritedTarget: 512 });
    expect(p.source).toBe('explicit');
    expect(p.chunkTokenTarget).toBe(1000);
    expect(p.policyChars).toBe(6000);
  });

  it.each([null, undefined, 0, -5, NaN])('falls back to inherited when explicit target is %s', target => {
    const p = resolveLakeHealthPolicy({ explicitTarget: target as number, inheritedTarget: 512 });
    expect(p.source).toBe('inherited');
    expect(p.chunkTokenTarget).toBe(512);
  });

  it('flags P4 (serveCapBelowPolicy) when the target exceeds the serve ceiling', () => {
    // target*6 must exceed SERVE_CHUNK_CHARS_CEILING (8000) -> target > 1333.
    const p = resolveLakeHealthPolicy({ explicitTarget: 2000, inheritedTarget: 512 });
    expect(p.policyChars).toBe(12000);
    expect(p.serveCap).toBe(SERVE_CHUNK_CHARS_CEILING); // clamped to 8000
    expect(p.serveCapBelowPolicy).toBe(true);
  });
});

describe('evaluateMemberHealth - P1 chunkWithinPolicy', () => {
  it('passes when the largest chunk is within the policy size', () => {
    const r = evaluateMemberHealth(member({ maxChunkCharLength: 3072 }), DEFAULT_POLICY);
    expect(r.status.chunkWithinPolicy).toBe('pass');
  });
  it('fails when a chunk exceeds the policy size', () => {
    const r = evaluateMemberHealth(member({ maxChunkCharLength: 3073 }), DEFAULT_POLICY);
    expect(r.status.chunkWithinPolicy).toBe('fail');
    expect(r.failed).toContain('chunkWithinPolicy');
  });
  it('is unknown when maxChunkCharLength is unmeasured (null)', () => {
    // A file the char-length backfill has not reached: its char AND embedded-char rollups are both
    // absent (the backfill stamps them together), so P1 is unknown and it has no reachable figure.
    const r = evaluateMemberHealth(
      member({ maxChunkCharLength: null, chunkedCharCount: null, embeddedCharCount: null }),
      DEFAULT_POLICY
    );
    expect(r.status.chunkWithinPolicy).toBe('unknown');
    expect(r.failed).not.toContain('chunkWithinPolicy');
    expect(r.measured).toBe(false);
  });
});

describe('evaluateMemberHealth - P2 chunkCountConsistent', () => {
  it('passes when chunkCount meets the length/policy expectation', () => {
    // 9000 chars / 3072 -> ceil = 3 expected; 3 chunks pass.
    const r = evaluateMemberHealth(
      member({ chunkCount: 3, chunkedCharCount: 9000, maxChunkCharLength: 3000 }),
      DEFAULT_POLICY
    );
    expect(r.status.chunkCountConsistent).toBe('pass');
  });
  it('fails the whole-document-in-one-chunk case', () => {
    // 20000 chars in ONE chunk: expected ceil(20000/3072)=7, actual 1 -> fail (and P1 fails too).
    const r = evaluateMemberHealth(
      member({ chunkCount: 1, chunkedCharCount: 20000, maxChunkCharLength: 20000 }),
      DEFAULT_POLICY
    );
    expect(r.status.chunkCountConsistent).toBe('fail');
    expect(r.status.chunkWithinPolicy).toBe('fail');
    expect(r.failed).toEqual(['chunkWithinPolicy', 'chunkCountConsistent']);
  });
  it('is unknown when chunkedCharCount is unmeasured', () => {
    const r = evaluateMemberHealth(member({ chunkedCharCount: null }), DEFAULT_POLICY);
    expect(r.status.chunkCountConsistent).toBe('unknown');
  });
  it('passes an empty-text file (0 chunked chars -> 0 expected)', () => {
    const r = evaluateMemberHealth(member({ chunkCount: 1, chunkedCharCount: 0 }), DEFAULT_POLICY);
    expect(r.status.chunkCountConsistent).toBe('pass');
  });
});

describe('evaluateMemberHealth - P3 fullyVectorized', () => {
  it('passes when every chunk carries a vector', () => {
    const r = evaluateMemberHealth(member({ chunkCount: 5, embeddedChunkCount: 5 }), DEFAULT_POLICY);
    expect(r.status.fullyVectorized).toBe('pass');
  });
  it('fails when some chunks are unvectorized', () => {
    const r = evaluateMemberHealth(member({ chunkCount: 5, embeddedChunkCount: 3 }), DEFAULT_POLICY);
    expect(r.status.fullyVectorized).toBe('fail');
    expect(r.failed).toContain('fullyVectorized');
  });
  it('is gradable from vector presence even when char data is unmeasured', () => {
    // P3 should be usable before the char-length backfill runs.
    const r = evaluateMemberHealth(
      member({ chunkCount: 4, embeddedChunkCount: 2, chunkedCharCount: null, maxChunkCharLength: null }),
      DEFAULT_POLICY
    );
    expect(r.status.fullyVectorized).toBe('fail');
    expect(r.measured).toBe(false);
  });
  it('is unknown when embeddedChunkCount is not computed (null)', () => {
    const r = evaluateMemberHealth(member({ embeddedChunkCount: null }), DEFAULT_POLICY);
    expect(r.status.fullyVectorized).toBe('unknown');
  });
});

describe('evaluateMemberHealth - reachableChars (the headline atom)', () => {
  it('equals chunked chars for a healthy, fully-embedded, in-cap file', () => {
    const r = evaluateMemberHealth(
      member({
        chunkCount: 3,
        chunkedCharCount: 9000,
        maxChunkCharLength: 3000,
        embeddedChunkCount: 3,
        embeddedCharCount: 9000,
      }),
      DEFAULT_POLICY
    );
    expect(r.reachableChars).toBe(9000); // min(9000, 3*3072=9216)
  });
  it('caps oversized chunks at the serve cap (all-oversized -> exact)', () => {
    // single oversized vector-bearing chunk of 20000 chars -> only serveCap (3072) reaches the model.
    const r = evaluateMemberHealth(
      member({
        chunkCount: 1,
        chunkedCharCount: 20000,
        maxChunkCharLength: 20000,
        embeddedChunkCount: 1,
        embeddedCharCount: 20000,
      }),
      DEFAULT_POLICY
    );
    expect(r.reachableChars).toBe(3072); // min(20000, 1*3072)
  });
  it('counts unvectorized content as unreachable', () => {
    // 4 chunks, only 2 embedded, embeddedCharCount reflects only the embedded chars.
    const r = evaluateMemberHealth(
      member({
        chunkCount: 4,
        chunkedCharCount: 12000,
        maxChunkCharLength: 3000,
        embeddedChunkCount: 2,
        embeddedCharCount: 6000,
      }),
      DEFAULT_POLICY
    );
    expect(r.reachableChars).toBe(6000); // min(6000, 2*3072=6144)
  });
  it('is null when embedded char data is unmeasured', () => {
    const r = evaluateMemberHealth(member({ embeddedCharCount: null }), DEFAULT_POLICY);
    expect(r.reachableChars).toBeNull();
  });
});

describe('evaluateMemberHealth - vectorization in flight vs settled', () => {
  it('treats a chunked-but-not-yet-vectorized file as PENDING, not 0%/failed', () => {
    // chunk-complete stamps the char rollups (so the file is "measured") and zeroes the vector
    // rollups in the SAME write; until the first vectorize batch commits vectorizedChunkCount < chunkCount.
    const r = evaluateMemberHealth(
      member({
        chunkCount: 3,
        chunkedCharCount: 9000,
        maxChunkCharLength: 3000,
        vectorizedChunkCount: 0,
        embeddedChunkCount: 0,
        embeddedCharCount: 0,
      }),
      DEFAULT_POLICY
    );
    expect(r.status.fullyVectorized).toBe('unknown'); // pending, NOT fail
    expect(r.failed).not.toContain('fullyVectorized');
    expect(r.reachableChars).toBeNull(); // excluded from the headline, not counted as zero
    expect(r.measured).toBe(false);
    // P1 still grades from the char rollups the moment they exist.
    expect(r.status.chunkWithinPolicy).toBe('pass');
  });

  it('grades a SETTLED-but-under-vectorized file as a real P3 failure', () => {
    // An un-embeddable oversized chunk counts as terminal, so vectorizedChunkCount reaches chunkCount
    // (settled) while embeddedChunkCount stays below it - the exact defect P3 exists to catch.
    const r = evaluateMemberHealth(
      member({
        chunkCount: 1,
        chunkedCharCount: 20000,
        maxChunkCharLength: 20000,
        vectorizedChunkCount: 1,
        embeddedChunkCount: 0,
        embeddedCharCount: 0,
      }),
      DEFAULT_POLICY
    );
    expect(r.status.fullyVectorized).toBe('fail');
    expect(r.failed).toContain('fullyVectorized');
  });

  it('treats an absent vectorizedChunkCount (legacy, predates the field) as settled', () => {
    const r = evaluateMemberHealth(
      member({ chunkCount: 5, vectorizedChunkCount: null, embeddedChunkCount: 3, embeddedCharCount: 100 }),
      DEFAULT_POLICY
    );
    expect(r.status.fullyVectorized).toBe('fail'); // still graded, not hidden as pending
  });

  it('treats a permanently-FAILED file (error set) as settled, so it fails P3 instead of hiding forever', () => {
    // A file whose vectorization errored never reaches vectorizedChunkCount >= chunkCount. Without the
    // error signal it would read as "still indexing" forever and drop out of the ratio entirely.
    const r = evaluateMemberHealth(
      member({
        chunkCount: 4,
        vectorizedChunkCount: 1, // stuck below chunkCount
        error: 'embedding provider rejected the request',
        chunkedCharCount: 12000,
        maxChunkCharLength: 3000,
        embeddedChunkCount: 0,
        embeddedCharCount: 0,
      }),
      DEFAULT_POLICY
    );
    expect(r.status.fullyVectorized).toBe('fail');
    expect(r.failed).toContain('fullyVectorized');
    expect(r.reachableChars).toBe(0); // real 0, counted - not null/excluded
    expect(r.measured).toBe(true);
  });

  it('a lake of only failed files reports 0% reachable (unhealthy), not "not measured"', () => {
    const report = summarizeLakeHealth(
      [
        member({
          fabFileId: 'f1',
          chunkCount: 2,
          vectorizedChunkCount: 0,
          error: 'boom',
          chunkedCharCount: 6000,
          maxChunkCharLength: 3000,
          embeddedChunkCount: 0,
          embeddedCharCount: 0,
        }),
      ],
      DEFAULT_POLICY
    );
    expect(report.reachableShare).toBe(0); // NOT null
    expect(report.coverage).toEqual({ measuredMembers: 1, membersWithChunks: 1 });
    expect(report.predicates.fullyVectorized.fail).toBe(1);
  });

  it('excludes an in-flight member from the lake reachable share (no red during ingest)', () => {
    const report = summarizeLakeHealth(
      [
        member({
          fabFileId: 'settled',
          chunkCount: 3,
          chunkedCharCount: 9000,
          maxChunkCharLength: 3000,
          vectorizedChunkCount: 3,
          embeddedChunkCount: 3,
          embeddedCharCount: 9000,
        }),
        member({
          fabFileId: 'indexing',
          chunkCount: 3,
          chunkedCharCount: 9000,
          maxChunkCharLength: 3000,
          vectorizedChunkCount: 0,
          embeddedChunkCount: 0,
          embeddedCharCount: 0,
        }),
      ],
      DEFAULT_POLICY
    );
    expect(report.reachableShare).toBe(1); // only the settled file counts, not a diluted ~50%
    expect(report.coverage).toEqual({ measuredMembers: 1, membersWithChunks: 2 });
    expect(report.predicates.fullyVectorized.unknown).toBe(1); // the indexing file is pending
    expect(report.predicates.fullyVectorized.fail).toBe(0);
  });
});

describe('summarizeLakeHealth', () => {
  it('excludes chunkless members (images, pending) from every ratio', () => {
    const report = summarizeLakeHealth(
      [
        member({ fabFileId: 'img', chunkCount: 0 }),
        member({
          fabFileId: 'doc',
          chunkCount: 3,
          chunkedCharCount: 9000,
          maxChunkCharLength: 3000,
          embeddedChunkCount: 3,
          embeddedCharCount: 9000,
        }),
      ],
      DEFAULT_POLICY
    );
    expect(report.coverage.membersWithChunks).toBe(1);
    expect(report.reachableShare).toBe(1);
  });

  it('reports reachableShare over MEASURED content only, and coverage separately', () => {
    const report = summarizeLakeHealth(
      [
        // measured, fully reachable
        member({
          fabFileId: 'a',
          chunkCount: 3,
          chunkedCharCount: 9000,
          maxChunkCharLength: 3000,
          embeddedChunkCount: 3,
          embeddedCharCount: 9000,
        }),
        // UNMEASURED (backfill has not run) - must not drag the share to 0
        member({
          fabFileId: 'b',
          chunkCount: 5,
          chunkedCharCount: null,
          maxChunkCharLength: null,
          embeddedChunkCount: 5,
          embeddedCharCount: null,
        }),
      ],
      DEFAULT_POLICY
    );
    expect(report.reachableShare).toBe(1); // only 'a' counts
    expect(report.coverage).toEqual({ measuredMembers: 1, membersWithChunks: 2 });
  });

  it('reproduces the motivating incident: green vectorization, a quarter reachable', () => {
    // A lake whose chunks are all vectorized but ~4x the serve cap: reachable ~= serveCap/chunkSize.
    const members = Array.from({ length: 10 }, (_, i) =>
      member({
        fabFileId: `big${i}`,
        chunkCount: 1,
        chunkedCharCount: 12288, // 4 * serveCap
        maxChunkCharLength: 12288,
        embeddedChunkCount: 1, // fully "vectorized" - every processing counter green
        embeddedCharCount: 12288,
      })
    );
    const report = summarizeLakeHealth(members, DEFAULT_POLICY);
    expect(report.predicates.fullyVectorized.pass).toBe(10); // counters green
    expect(report.predicates.chunkWithinPolicy.fail).toBe(10); // but oversized
    expect(report.reachableShare).toBeCloseTo(0.25, 5); // only a quarter reaches the model
  });

  it('returns null reachableShare when nothing is measured yet', () => {
    const report = summarizeLakeHealth(
      [member({ chunkCount: 5, chunkedCharCount: null, maxChunkCharLength: null, embeddedCharCount: null })],
      DEFAULT_POLICY
    );
    expect(report.reachableShare).toBeNull();
    expect(report.measuredChunkedChars).toBe(0);
  });

  it('surfaces P4 as a lake-level predicate independent of members', () => {
    const bigPolicy = resolveLakeHealthPolicy({ explicitTarget: 2000, inheritedTarget: 512 });
    const report = summarizeLakeHealth(
      [member({ chunkCount: 1, chunkedCharCount: 100, maxChunkCharLength: 100, embeddedCharCount: 100 })],
      bigPolicy
    );
    expect(report.predicates.serveCapMeetsPolicy).toBe('fail');
  });

  it('orders affected members worst-first (more failures, then less reachable)', () => {
    const report = summarizeLakeHealth(
      [
        // one failure (P3), still fairly reachable
        member({
          fabFileId: 'oneFail',
          chunkCount: 4,
          chunkedCharCount: 12000,
          maxChunkCharLength: 3000,
          embeddedChunkCount: 3,
          embeddedCharCount: 9000,
        }),
        // two failures (P1 + P2), barely reachable
        member({
          fabFileId: 'twoFail',
          chunkCount: 1,
          chunkedCharCount: 20000,
          maxChunkCharLength: 20000,
          embeddedChunkCount: 1,
          embeddedCharCount: 20000,
        }),
      ],
      DEFAULT_POLICY
    );
    expect(report.affectedMembers.map(m => m.fabFileId)).toEqual(['twoFail', 'oneFail']);
  });

  it('leaves affectedMembers empty for a clean lake', () => {
    const report = summarizeLakeHealth(
      [
        member({
          chunkCount: 3,
          chunkedCharCount: 9000,
          maxChunkCharLength: 3000,
          embeddedChunkCount: 3,
          embeddedCharCount: 9000,
        }),
      ],
      DEFAULT_POLICY
    );
    expect(report.affectedMembers).toHaveLength(0);
  });
});

describe('evaluateMemberHealth - passages DELETED by a halted wave must fail, not abstain', () => {
  // The other half of the same bug. `resetChunkStateByIds` nulls all four rollups in the write that
  // deletes the passages, so every predicate below used to abstain on absence: the member graded
  // `unknown` across the board, landed in neither `failed` nor the ratio, and the lake still read
  // "Reachable 100%" with an empty drill-down - the exact reported symptom.
  //
  // Every rollup here is `null`, deliberately, because that is what the reset actually writes. Zeros
  // would take a different branch at each predicate and let a broken implementation pass.
  const stranded = (over: Partial<LakeHealthMemberInput> = {}): LakeHealthMemberInput => ({
    fabFileId: 'stranded',
    chunkCount: 0,
    vectorizedChunkCount: 0,
    error: null,
    chunkStallReason: 'rechunkPaused',
    chunkedCharCount: null,
    maxChunkCharLength: null,
    embeddedChunkCount: null,
    embeddedCharCount: null,
    ...over,
  });

  it('fails P3 on its proven zero rather than grading unknown', () => {
    const r = evaluateMemberHealth(stranded(), DEFAULT_POLICY);
    expect(r.status.fullyVectorized).toBe('fail');
    expect(r.failed).toContain('fullyVectorized');
    expect(r.reachableChars).toBe(0);
    expect(r.measured).toBe(true);
  });

  it('is named in the drill-down, and drops the lake off a fully-passing predicate tally', () => {
    const healthy = member({ fabFileId: 'ok', chunkCount: 1, chunkedCharCount: 2000, embeddedCharCount: 2000 });
    const summary = summarizeLakeHealth([healthy, stranded()], DEFAULT_POLICY);
    expect(summary.affectedMembers.map(m => m.fabFileId)).toEqual(['stranded']);
    expect(summary.predicates.fullyVectorized.fail).toBe(1);
    expect(summary.predicates.fullyVectorized.unknown).toBe(0);
  });

  it('does NOT keep failing a member the rescue sweep rebuilt (marker outlives the repair)', () => {
    // That path enqueues without a reset, so a marker left behind survives a successful re-chunk. Keying on it alone would fail a healthy file forever.
    const rebuilt = stranded({
      chunkCount: 1,
      vectorizedChunkCount: 1,
      chunkedCharCount: 2000,
      maxChunkCharLength: 2000,
      embeddedChunkCount: 1,
      embeddedCharCount: 2000,
    });
    const r = evaluateMemberHealth(rebuilt, DEFAULT_POLICY);
    expect(r.status.fullyVectorized).toBe('pass');
    expect(r.failed).toEqual([]);
    expect(r.reachableChars).toBe(2000);
  });

  it('leaves the vectorize-arm marker alone - it has chunks, so it grades on its real rollups', () => {
    const r = evaluateMemberHealth(stranded({ chunkCount: 0, chunkStallReason: 'vectorizePaused' }), DEFAULT_POLICY);
    expect(r.status.fullyVectorized).toBe('unknown');
  });
});

describe('evaluateMemberHealth - convergence-paused files must GRADE, not hide', () => {
  // The kill switch (#1676) abandons a vectorize by stamping `chunkStallReason` and
  // clearing isVectorizing. It never sets `error`, so before that arm such a file satisfied no
  // settled condition and hid from BOTH sides of the reachable ratio - forever, since the handler
  // states these do not auto-resume. A lake where most files were paused mid-sweep would then report
  // a healthy share over the few that finished. Same failure mode `error` exists to catch.
  const paused = (over: Partial<LakeHealthMemberInput> = {}) =>
    member({
      chunkCount: 4,
      chunkedCharCount: 8000,
      maxChunkCharLength: 2000,
      vectorizedChunkCount: 1, // stalled below chunkCount
      embeddedChunkCount: 1,
      embeddedCharCount: 2000,
      chunkStallReason: 'vectorizePaused',
      ...over,
    });

  it('grades a paused file as SETTLED, so it fails P3 and contributes its real reachable chars', () => {
    const r = evaluateMemberHealth(paused(), DEFAULT_POLICY);
    expect(r.status.fullyVectorized).toBe('fail'); // not 'unknown'
    expect(r.failed).toContain('fullyVectorized');
    expect(r.measured).toBe(true);
    expect(r.reachableChars).toBe(2000); // its real partial figure, not null
  });

  it('still treats an ordinary mid-vectorize file as pending', () => {
    // The discriminator must be the stall reason, not merely "vectorizedChunkCount < chunkCount".
    const r = evaluateMemberHealth(paused({ chunkStallReason: null }), DEFAULT_POLICY);
    expect(r.status.fullyVectorized).toBe('unknown');
    expect(r.reachableChars).toBeNull();
    expect(r.measured).toBe(false);
  });

  // #2016: `chunkStallReason` is enum-valued, so a value outside CHUNK_STALL_REASONS is a writer bug
  // and must NOT be read as a stall - a fail-open here would grade a mid-vectorize file as settled.
  it('does not treat an unrecognized stall reason as a terminal stall', () => {
    const r = evaluateMemberHealth(paused({ chunkStallReason: 'somethingElse' }), DEFAULT_POLICY);
    expect(r.measured).toBe(false); // still pending, not graded
  });

  // The owner's own note is not a pipeline fact and must not move any grade (#2016).
  it('ignores the owner note entirely', () => {
    const r = evaluateMemberHealth(paused({ chunkStallReason: null, notes: 'my contract notes' }), DEFAULT_POLICY);
    expect(r.measured).toBe(false);
  });

  it('keeps a paused file in the lake denominator instead of shrinking it', () => {
    // The headline bug: a paused file used to vanish from numerator AND denominator, so a lake that
    // was mostly paused reported the healthy share of its survivors.
    const finished = member({
      fabFileId: 'ok',
      chunkCount: 2,
      chunkedCharCount: 2000,
      maxChunkCharLength: 1000,
      vectorizedChunkCount: 2,
      embeddedChunkCount: 2,
      embeddedCharCount: 2000,
    });
    const summary = summarizeLakeHealth([finished, paused({ fabFileId: 'stalled' })], DEFAULT_POLICY);
    expect(summary.measuredChunkedChars).toBe(10000); // 2000 finished + 8000 paused, not 2000 alone
    expect(summary.reachableShare).toBeCloseTo(0.4, 5); // (2000 + 2000) / 10000, not 1.0
  });
});

describe('evaluateMemberHealth - a rebuild in progress must read as pending, not as damage', () => {
  // #1939. Same shape on disk as the halted member above - chunkless, all four rollups null - and it
  // must grade the OPPOSITE way, because the only difference is whether anything is coming back.
  // The stamp is what tells them apart. Every rollup is `null`, deliberately, because that is what
  // `resetChunkStateByIds` writes; zeros would take a different branch at each predicate.
  const rebuilding = (over: Partial<LakeHealthMemberInput> = {}): LakeHealthMemberInput => ({
    fabFileId: 'rebuilding',
    chunkCount: 0,
    vectorizedChunkCount: 0,
    error: null,
    chunkStallReason: null,
    chunkRebuildRequestedAt: new Date('2026-08-20T00:00:00Z'),
    chunkedCharCount: null,
    maxChunkCharLength: null,
    embeddedChunkCount: null,
    embeddedCharCount: null,
    ...over,
  });

  // Hard-failing P3 here is the failure mode the whole design avoids: it would paint a lake red for
  // the length of every ordinary "Rebuild passages" wave and every per-file reprocess.
  it('grades P3 as pending and contributes nothing to the ratio', () => {
    const r = evaluateMemberHealth(rebuilding(), DEFAULT_POLICY);
    expect(r.status.fullyVectorized).toBe('unknown');
    expect(r.failed).toEqual([]);
    expect(r.reachableChars).toBeNull();
    expect(r.measured).toBe(false);
  });

  // Being IN the member set is the whole point - a member that is merely absent is one nobody can
  // tell from a lake that never had it. It shows up as coverage below 1, not as a failure.
  it('stays in the lake report as unmeasured coverage instead of disappearing', () => {
    const healthy = member({ fabFileId: 'ok', chunkCount: 1, chunkedCharCount: 2000, embeddedCharCount: 2000 });
    const summary = summarizeLakeHealth([healthy, rebuilding()], DEFAULT_POLICY);

    expect(summary.coverage).toEqual({ measuredMembers: 1, membersWithChunks: 2 });
    expect(summary.affectedMembers).toEqual([]);
    expect(summary.predicates.fullyVectorized.fail).toBe(0);
    expect(summary.predicates.fullyVectorized.unknown).toBe(1);
    // The measured member still sets the headline: a rebuild in flight must not drag it to 0%.
    expect(summary.reachableShare).toBe(1);
  });

  // A rebuild that STOPPED is not one still running, so both settled markers outrank a stamp left
  // behind - otherwise a halted member would hide in the pending bucket instead of failing P3.
  it('lets the halted marker and a terminal error outrank a leftover stamp', () => {
    expect(
      evaluateMemberHealth(rebuilding({ chunkStallReason: 'rechunkPaused' }), DEFAULT_POLICY).status.fullyVectorized
    ).toBe('fail');
    const failed = evaluateMemberHealth(rebuilding({ error: 'boom', embeddedChunkCount: 0 }), DEFAULT_POLICY);
    expect(failed.status.fullyVectorized).toBe('pass'); // 0 embedded >= 0 chunks: settled, nothing owed
    expect(failed.measured).toBe(false); // its char rollups are gone, so it contributes no ratio
  });

  // The stamp is cleared transactionally by commitFabFileChunks, so a rebuilt member grades on its
  // real rollups again rather than being parked as in-flight forever.
  it('grades normally once the rebuild has committed and cleared the stamp', () => {
    const rebuilt = rebuilding({
      chunkRebuildRequestedAt: null,
      chunkCount: 1,
      vectorizedChunkCount: 1,
      chunkedCharCount: 2000,
      maxChunkCharLength: 2000,
      embeddedChunkCount: 1,
      embeddedCharCount: 2000,
    });
    const r = evaluateMemberHealth(rebuilt, DEFAULT_POLICY);
    expect(r.status.fullyVectorized).toBe('pass');
    expect(r.reachableChars).toBe(2000);
  });
});

// `evaluateMemberHealth`'s own settled test is a hand-written mirror of `isMemberIndexingInFlight`,
// which convergence and the retrieval withhold call directly. The two must agree arm for arm, or a
// member reads as in flight to search and as settled to health at the same moment. Pinned as
// behaviour rather than by reading the private const: P3 is exactly `unknown` while indexing is in
// flight, given rollups that would otherwise decide it.
describe('lake health and convergence agree on what "still indexing" means', () => {
  const shapes: Array<{ name: string; over: Partial<LakeHealthMemberInput> }> = [
    { name: 'settled and fully embedded', over: { chunkCount: 2, vectorizedChunkCount: 2 } },
    { name: 'vector rollup still short', over: { chunkCount: 2, vectorizedChunkCount: 1 } },
    { name: 'terminally failed', over: { chunkCount: 2, vectorizedChunkCount: 0, error: 'boom' } },
    {
      name: 'halted by the kill switch',
      over: { chunkCount: 2, vectorizedChunkCount: 0, chunkStallReason: 'vectorizePaused' },
    },
    { name: 'legacy null vector rollup', over: { chunkCount: 2, vectorizedChunkCount: null } },
    {
      name: 'rebuild outstanding',
      over: { chunkCount: 0, vectorizedChunkCount: 0, chunkRebuildRequestedAt: new Date() },
    },
    {
      name: 'stamp left behind by a failed rebuild',
      over: { chunkCount: 0, vectorizedChunkCount: 0, chunkRebuildRequestedAt: new Date(), error: 'boom' },
    },
  ];

  for (const { name, over } of shapes) {
    it(`agrees for a member that is ${name}`, () => {
      const m = member({ embeddedChunkCount: over.chunkCount ?? 0, ...over });
      const inFlight = isMemberIndexingInFlight({
        chunkCount: m.chunkCount,
        vectorizedChunkCount: m.vectorizedChunkCount,
        error: m.error,
        chunkStallReason: m.chunkStallReason,
        chunkRebuildRequestedAt: m.chunkRebuildRequestedAt,
      });
      expect(evaluateMemberHealth(m, DEFAULT_POLICY).status.fullyVectorized === 'unknown').toBe(inFlight);
    });
  }
});
