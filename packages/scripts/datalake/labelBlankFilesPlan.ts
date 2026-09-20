/**
 * Decision logic for the FILE-level label repair (see label-blank-embedding-model-files.ts).
 *
 * Mirrors `resolveFileLabel` in b4m-core/services/src/fabFileService/stampChunkEmbeddingModel.ts,
 * which is module-private and cannot be called directly. Mirrored rather than re-derived because
 * the pass has to know what it WILL do before it writes: `stampChunkEmbeddingModel` returns void
 * and, on every branch that is not a stamp, writes the file label as null - which for this
 * population is already its value. Without this the dry run could only guess and an execute run
 * could not tell a stamp from a silent no-op.
 *
 * Adds one guard `resolveFileLabel` does not have, because this caller is not the one it was
 * written for: see ATTRIBUTABLE_VECTOR_WIDTH.
 *
 * Must stay in sync with resolveFileLabel. labelBlankFilesPlan.test.ts pins every branch.
 */

/**
 * The only vector width this pass will attribute to a model without a chunk label to read.
 *
 * `stampChunkEmbeddingModel` reserves `stampFile` for the vectorize handler, which knows what it
 * just embedded. A file label is exclusion authority - wrong, it drops a healthy file out of search
 * wholesale - so a backfill guessing one from width alone is normally too weak to be allowed: ten
 * registered models share 1024 dimensions.
 *
 * This pass is exempt only as a measured property of the corpus it runs against, where every
 * unlabeled vector is 1536 wide. At that width the candidates are ada-002 and 3-small, and 3-small
 * has never been a cloud default, so the attribution comes from deployment history rather than from
 * the width itself. That argument covers 1536 and nothing else, which is why this is an allowlist
 * and not a 1024 denylist: a 3072-wide unlabeled vector is exactly as unattributable as a 1024-wide
 * one, and so is a width no model claims at all. Anything else, the pass skips the file rather than
 * guess.
 */
export const ATTRIBUTABLE_VECTOR_WIDTH = 1536;

export type SkipReason =
  'no-vector-bearing-chunks' | 'foreign-chunk-label' | 'spans-multiple-spaces' | 'unattributable-vector-width';

/** @see residualBucket - the three standing categories a still-unlabeled file can be in. */
export type ResidualBucket = 'owed-a-label' | 'deliberately-blank' | 'counter-only';

export type LabelDecision =
  { action: 'stamp'; label: string } | { action: 'skip'; reason: SkipReason; declared: string[] };

export interface FileLabelEvidence {
  /** Distinct non-blank `embeddingModel` values across the file's vector-bearing chunks. */
  declaredModels: string[];
  /** How many of those chunks carry no label. Empty `declaredModels` means opposite things at 0 and >0. */
  unlabeledVectorChunks: number;
  /** Distinct widths among the UNLABELED chunks only - the labeled ones need no width argument. */
  unlabeledVectorWidths: number[];
}

/**
 * Whether this file's FILE-level label can be set to `embeddingModel`, given what its chunks
 * declare. `unlabeledVectorChunks` is what separates "holds no vectors at all" from "holds vectors
 * that are all unlabeled" - `declaredModels` reads empty for both, and they want opposite answers.
 *
 * The caller's model is only unioned in when there ARE unlabeled vector chunks for it to describe:
 * a model that embedded nothing in this file is evidence about nothing in it. Unioning it is also
 * the only branch that rests on width, so that is where the width guard sits - a file whose chunks
 * are already fully labeled needs no width argument, because it is not being guessed about.
 */
export function classifyFileLabel(evidence: FileLabelEvidence, embeddingModel: string): LabelDecision {
  const { declaredModels, unlabeledVectorChunks, unlabeledVectorWidths } = evidence;
  const declared = new Set(declaredModels);

  if (unlabeledVectorChunks > 0) {
    const unattributable = unlabeledVectorWidths.filter(w => w !== ATTRIBUTABLE_VECTOR_WIDTH);
    if (unattributable.length > 0) {
      return { action: 'skip', reason: 'unattributable-vector-width', declared: [...declared].sort() };
    }
    declared.add(embeddingModel);
  }

  if (declared.size === 0) {
    return { action: 'skip', reason: 'no-vector-bearing-chunks', declared: [] };
  }
  if (declared.size === 1) {
    const [only] = [...declared];
    if (only === embeddingModel) return { action: 'stamp', label: only };
    // A chunk label written by something else. Promoting it would make the file's exclusion
    // authority repeat a claim this pass cannot vouch for.
    return { action: 'skip', reason: 'foreign-chunk-label', declared: [only] };
  }
  return { action: 'skip', reason: 'spans-multiple-spaces', declared: [...declared].sort() };
}

/**
 * Which standing category a STILL-UNLABELED file belongs to, for the completion check.
 *
 * Two of the four skip reasons can never be cleared by any number of runs, and conflating them with
 * the ones that can is what makes a naive completion predicate unsatisfiable:
 *
 * - `counter-only` - `vectorizedChunkCount` is a rollup that outlives the chunks it counted, so a
 *   file can claim vectors it no longer holds. There is no label to write because there is nothing
 *   to describe, and re-running cannot change that.
 * - `deliberately-blank` - the file holds vectors in two spaces and no single label is true of both.
 *   Blank IS the correct value here; writing one would give the file exclusion authority over a
 *   claim that is false for half its chunks.
 *
 * So "every vectorized file carries a label" is the wrong bar - it can never be met. `owed-a-label`
 * is the population that must reach zero: a file holding vectors in ONE space with no file-level
 * label, whether this pass can resolve it (`stamp`) or has to refuse it (`foreign-chunk-label`,
 * `unattributable-vector-width`). A refusal still leaves the file stranded across a default flip, so
 * it belongs in the count even though this pass is not the thing that can fix it.
 *
 * Delegates to `classifyFileLabel` rather than re-testing the evidence, so the completion check and
 * the write decision cannot disagree about what a file is.
 */
export function residualBucket(evidence: FileLabelEvidence, embeddingModel: string): ResidualBucket {
  const decision = classifyFileLabel(evidence, embeddingModel);
  if (decision.action === 'stamp') return 'owed-a-label';
  switch (decision.reason) {
    case 'no-vector-bearing-chunks':
      return 'counter-only';
    case 'spans-multiple-spaces':
      return 'deliberately-blank';
    default:
      return 'owed-a-label';
  }
}

export interface FileLabelPlan {
  stamp: Array<{ fabFileId: string; label: string }>;
  skipped: Array<{ fabFileId: string; reason: SkipReason; declared: string[] }>;
  /**
   * Files that carry no `chunkEmbeddingModelStampedAt` yet. The stamp writes that field
   * unconditionally and it is ANN-eligibility authority, so a rollback needs these ids to unwind
   * more than the label - `$unset embeddingModel` alone would leave them ANN-eligible and unlabeled.
   */
  rollbackStampedAtIds: string[];
}

/** The unwind for a file that already carried a `chunkEmbeddingModelStampedAt` this pass did not write. */
export const ROLLBACK_LABEL_ONLY = 'embeddingModel';
/** The unwind for a file whose `chunkEmbeddingModelStampedAt` this pass wrote alongside the label. */
export const ROLLBACK_LABEL_AND_STAMPED_AT = 'embeddingModel+chunkEmbeddingModelStampedAt';

/**
 * One rollback-log line per stamped file: the id, then the fields an unwind must clear.
 *
 * Every stamped id is recorded, not just the ones needing a stampedAt unwind, because the stamped
 * set cannot be re-derived afterwards - a stamped file leaves
 * `findVectorizedFilesMissingEmbeddingModel`'s filter, so once the pass has run there is nothing
 * left to ask which files it labeled. The field list is per file because clearing
 * `chunkEmbeddingModelStampedAt` where the pass did not write it would unwind a write it never made,
 * and that field is ANN-eligibility authority.
 */
export function rollbackLogLines(plan: FileLabelPlan): string[] {
  const wroteStampedAt = new Set(plan.rollbackStampedAtIds);
  return plan.stamp.map(
    s => `${s.fabFileId} ${wroteStampedAt.has(s.fabFileId) ? ROLLBACK_LABEL_AND_STAMPED_AT : ROLLBACK_LABEL_ONLY}`
  );
}

export interface FileLabelCandidate extends FileLabelEvidence {
  id: string;
  chunkEmbeddingModelStampedAt: Date | null;
}

/**
 * Turn one page of candidate files into a plan. Pure: every read the decision needs is already in
 * `candidates`, so the same page always yields the same plan and the dry run is the execute run
 * minus the writes.
 */
export function planFileLabels(candidates: FileLabelCandidate[], embeddingModel: string): FileLabelPlan {
  const plan: FileLabelPlan = { stamp: [], skipped: [], rollbackStampedAtIds: [] };

  for (const file of candidates) {
    const decision = classifyFileLabel(file, embeddingModel);
    if (decision.action === 'stamp') {
      plan.stamp.push({ fabFileId: file.id, label: decision.label });
      if (!file.chunkEmbeddingModelStampedAt) plan.rollbackStampedAtIds.push(file.id);
    } else {
      plan.skipped.push({ fabFileId: file.id, reason: decision.reason, declared: decision.declared });
    }
  }

  return plan;
}
