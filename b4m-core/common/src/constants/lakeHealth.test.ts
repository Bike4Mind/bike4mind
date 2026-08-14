import { describe, it, expect } from 'vitest';
import { DEFAULT_PASSAGE_TOKEN_TARGET, CHARS_PER_TOKEN_SERVE_BOUND, SERVE_CHUNK_CHARS_CEILING } from './chunking';
import {
  resolveLakeHealthPolicy,
  evaluateMemberHealth,
  summarizeLakeHealth,
  type LakeHealthMemberInput,
} from './lakeHealth';

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
