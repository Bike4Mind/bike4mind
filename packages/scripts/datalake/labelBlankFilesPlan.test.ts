import { describe, it, expect } from 'vitest';
import {
  ATTRIBUTABLE_VECTOR_WIDTH,
  classifyFileLabel,
  planFileLabels,
  residualBucket,
  rollbackLogLines,
  ROLLBACK_LABEL_AND_STAMPED_AT,
  ROLLBACK_LABEL_ONLY,
  type FileLabelCandidate,
} from './labelBlankFilesPlan';

const ADA = 'text-embedding-ada-002';
const SMALL = 'text-embedding-3-small';
const W = ATTRIBUTABLE_VECTOR_WIDTH;

/** A fully chunk-labeled file: nothing unlabeled, so no width evidence exists or is needed. */
const labeled = (declaredModels: string[]) => ({
  declaredModels,
  unlabeledVectorChunks: 0,
  unlabeledVectorWidths: [],
});

/** A file with unlabeled vectors, whose label therefore rests on their width. */
const unlabeled = (count: number, widths: number[] = [W], declaredModels: string[] = []) => ({
  declaredModels,
  unlabeledVectorChunks: count,
  unlabeledVectorWidths: widths,
});

describe('classifyFileLabel mirrors resolveFileLabel', () => {
  it('stamps a file whose chunks are already fully labeled with the pass model', () => {
    // The bulk of the population: chunk labels present and complete, file label blank.
    expect(classifyFileLabel(labeled([ADA]), ADA)).toEqual({ action: 'stamp', label: ADA });
  });

  it('stamps a file whose vectors are all unlabeled, unioning the pass model in', () => {
    // The minority sub-population: nothing declared, so the count is the only evidence that there
    // are vectors at all. Without the union this would read as "no vector-bearing chunks".
    expect(classifyFileLabel(unlabeled(92), ADA)).toEqual({ action: 'stamp', label: ADA });
  });

  it('refuses a file holding only labels the pass did not write, rather than promoting them', () => {
    // The guard that makes a wrong --model loud instead of silent: the file label is exclusion
    // authority, so repeating a claim this pass cannot vouch for would drop a healthy file.
    expect(classifyFileLabel(labeled([ADA]), SMALL)).toEqual({
      action: 'skip',
      reason: 'foreign-chunk-label',
      declared: [ADA],
    });
  });

  it('refuses a file with no vector-bearing chunks at all', () => {
    // Distinct from the unlabeled case above and reached with the identical declared set - only
    // the count separates them.
    expect(classifyFileLabel(labeled([]), ADA)).toEqual({
      action: 'skip',
      reason: 'no-vector-bearing-chunks',
      declared: [],
    });
  });

  it('refuses a file whose chunks span two spaces, whose blank label is deliberate', () => {
    // This shape is why the pass re-derives per file instead of stamping every blank-label row:
    // stampChunkEmbeddingModel cleared this label on purpose, and a single value would be a lie
    // about half the vectors.
    expect(classifyFileLabel(labeled([SMALL, ADA]), ADA)).toEqual({
      action: 'skip',
      reason: 'spans-multiple-spaces',
      // Sorted, and 'text-embedding-3-small' precedes 'text-embedding-ada-002' ('3' < 'a').
      declared: [SMALL, ADA],
    });
  });

  it('still refuses a split file when its unlabeled chunks would union in the pass model', () => {
    // The union pushes the set to 2, not back to 1.
    expect(classifyFileLabel(unlabeled(5, [W], [SMALL]), ADA)).toMatchObject({
      action: 'skip',
      reason: 'spans-multiple-spaces',
    });
  });
});

describe('the vector-width allowlist', () => {
  it('refuses a 1024-wide unlabeled vector, which ten models could have written', () => {
    expect(classifyFileLabel(unlabeled(4, [1024]), ADA)).toEqual({
      action: 'skip',
      reason: 'unattributable-vector-width',
      declared: [],
    });
  });

  it('refuses a 3072-wide unlabeled vector too, not just the 1024 collision', () => {
    // A denylist aimed at 1024 would stamp this one ada-002, which is the wrong space entirely.
    expect(classifyFileLabel(unlabeled(4, [3072]), ADA)).toMatchObject({
      reason: 'unattributable-vector-width',
    });
  });

  it('refuses a file holding one attributable width and one that is not', () => {
    // The distinct set is read whole precisely so a single odd row is not averaged away.
    expect(classifyFileLabel(unlabeled(8, [1024, W]), ADA)).toMatchObject({
      reason: 'unattributable-vector-width',
    });
  });

  it('refuses the malformed-vector sentinel the width reader emits for a non-array', () => {
    expect(classifyFileLabel(unlabeled(1, [-1]), ADA)).toMatchObject({
      reason: 'unattributable-vector-width',
    });
  });

  it('does not consult width for a file whose chunks are all labeled', () => {
    // Width is only evidence when there is no chunk label to read. A labeled 1024-wide file is
    // attributed by its own label, so the guard must not reach it - several such files exist.
    expect(classifyFileLabel({ ...labeled([ADA]), unlabeledVectorWidths: [1024] }, ADA)).toEqual({
      action: 'stamp',
      label: ADA,
    });
  });

  it('reports the declared set alongside an unattributable width, for the operator', () => {
    expect(classifyFileLabel(unlabeled(2, [1024], [SMALL, ADA]), ADA)).toEqual({
      action: 'skip',
      reason: 'unattributable-vector-width',
      declared: [SMALL, ADA],
    });
  });
});

describe('planFileLabels', () => {
  it('partitions a page and records only the stamped files that need a stampedAt rollback', () => {
    const page: FileLabelCandidate[] = [
      // Stamped, already carries a stampedAt: label-only rollback is enough.
      { id: 'f1', ...labeled([ADA]), chunkEmbeddingModelStampedAt: new Date() },
      // Stamped, no stampedAt yet: the pass will write one, so it has to be unwindable.
      { id: 'f2', ...unlabeled(3), chunkEmbeddingModelStampedAt: null },
      // Skipped. Nothing is written for it, so it must NOT enter the rollback set even though it
      // has no stampedAt - unwinding a field the pass never wrote would clear a real one.
      { id: 'f3', ...labeled([SMALL]), chunkEmbeddingModelStampedAt: null },
    ];
    const plan = planFileLabels(page, ADA);

    expect(plan.stamp).toEqual([
      { fabFileId: 'f1', label: ADA },
      { fabFileId: 'f2', label: ADA },
    ]);
    expect(plan.skipped).toEqual([{ fabFileId: 'f3', reason: 'foreign-chunk-label', declared: [SMALL] }]);
    expect(plan.rollbackStampedAtIds).toEqual(['f2']);
  });

  it('plans nothing to stamp when the pass model matches no chunk label in the page', () => {
    // A wrong --model does not half-work: every file falls to the same skip branch, which is what
    // the script turns into a refusal to execute.
    const plan = planFileLabels(
      [
        { id: 'f1', ...labeled([ADA]), chunkEmbeddingModelStampedAt: null },
        { id: 'f2', ...labeled([ADA]), chunkEmbeddingModelStampedAt: null },
      ],
      SMALL
    );

    expect(plan.stamp).toEqual([]);
    expect(plan.skipped).toHaveLength(2);
    expect(plan.rollbackStampedAtIds).toEqual([]);
  });
});

describe('rollbackLogLines', () => {
  it('records every stamped id, marking only the ones whose stampedAt this pass wrote', () => {
    // The whole set, because a stamped file leaves the finder's filter: after the pass there is no
    // query that returns "the files this run labeled", so an id absent here is unrecoverable.
    const plan = planFileLabels(
      [
        { id: 'f1', ...labeled([ADA]), chunkEmbeddingModelStampedAt: new Date() },
        { id: 'f2', ...unlabeled(3), chunkEmbeddingModelStampedAt: null },
      ],
      ADA
    );

    expect(rollbackLogLines(plan)).toEqual([`f1 ${ROLLBACK_LABEL_ONLY}`, `f2 ${ROLLBACK_LABEL_AND_STAMPED_AT}`]);
  });

  it('never marks a file that already carried a stampedAt, which the pass must not clear', () => {
    // The distinction the per-file field list exists for: clearing it here would unwind a write
    // this pass never made, and the field is ANN-eligibility authority.
    const plan = planFileLabels([{ id: 'f1', ...labeled([ADA]), chunkEmbeddingModelStampedAt: new Date() }], ADA);

    expect(rollbackLogLines(plan)).toEqual([`f1 ${ROLLBACK_LABEL_ONLY}`]);
    expect(rollbackLogLines(plan)[0]).not.toContain('chunkEmbeddingModelStampedAt');
  });

  it('records nothing for a page that stamps nothing, rather than an empty marked line', () => {
    // An empty array is what keeps the caller from appending a bare newline to the log.
    const plan = planFileLabels([{ id: 'f1', ...labeled([SMALL]), chunkEmbeddingModelStampedAt: null }], ADA);

    expect(plan.stamp).toEqual([]);
    expect(rollbackLogLines(plan)).toEqual([]);
  });
});

describe('residualBucket', () => {
  it('counts a file this pass can stamp as still owed a label', () => {
    expect(residualBucket(labeled([ADA]), ADA)).toBe('owed-a-label');
    expect(residualBucket(unlabeled(92), ADA)).toBe('owed-a-label');
  });

  it('counts a refusal this pass cannot resolve as still owed a label', () => {
    // The pass is not the thing that can fix either of these, but the file is stranded across a
    // default flip exactly as much as a stampable one, so excluding them would report a completed
    // repair over files that still go dark.
    expect(residualBucket(labeled([SMALL]), ADA)).toBe('owed-a-label');
    expect(residualBucket(unlabeled(5, [1024]), ADA)).toBe('owed-a-label');
  });

  it('excludes the two categories no run can ever clear', () => {
    // These are why the naive "every vectorized file carries a label" predicate has no zero: one
    // has nothing to describe, the other is correctly blank. Both are reported every run forever.
    expect(residualBucket(labeled([]), ADA)).toBe('counter-only');
    expect(residualBucket(labeled([ADA, SMALL]), ADA)).toBe('deliberately-blank');
  });

  it('agrees with classifyFileLabel on every shape, so the two cannot drift', () => {
    // The completion check and the write decision must not be able to disagree about what a file
    // is; this pins the delegation rather than trusting it.
    const shapes = [
      labeled([ADA]),
      labeled([SMALL]),
      labeled([]),
      labeled([ADA, SMALL]),
      unlabeled(92),
      unlabeled(5, [1024]),
    ];
    for (const shape of shapes) {
      const decision = classifyFileLabel(shape, ADA);
      const expected =
        decision.action === 'stamp'
          ? 'owed-a-label'
          : decision.reason === 'no-vector-bearing-chunks'
            ? 'counter-only'
            : decision.reason === 'spans-multiple-spaces'
              ? 'deliberately-blank'
              : 'owed-a-label';
      expect(residualBucket(shape, ADA)).toBe(expected);
    }
  });
});
