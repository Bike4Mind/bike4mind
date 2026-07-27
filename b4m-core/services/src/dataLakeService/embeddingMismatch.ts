import type { SupportedEmbeddingModel } from '@bike4mind/common';

/**
 * Detection and accounting for chunks that cannot be meaningfully cosine-compared to a query
 * embedding because they were embedded with a different model.
 *
 * Shared by BOTH data-lake ranking loops - semanticDataLakeSearch's rankChunksForFiles (the
 * endpoint, the chat KB tool and the RLM tools) and KnowledgeRetrievalFeature's forced-retrieval
 * injection - so the two apply one definition of "cannot be compared". They still resolve the
 * QUERY model differently (the tool reads the admin setting, forced retrieval infers it from the
 * corpus), and that choice is what any given chunk is then judged against.
 *
 * Two distinct failure modes, and only one of them is visible to a vector-width check:
 *  - different WIDTH (e.g. an Ollama embedder at 768 vs OpenAI at 1536): computeCosineSimilarity
 *    returns 0 for these. That is not the same as dropping them - callers using a minScore of 0
 *    (both data-lake surfaces do) returned them as score-0 results, so they occupied result slots
 *    while carrying no signal.
 *  - SAME width, different model: text-embedding-ada-002 and text-embedding-3-small are both
 *    1536 dims, so a length check cannot tell them apart. Their vectors live in different spaces,
 *    and the resulting similarity is noise that can outrank a genuine match. This is why the
 *    parent file's recorded model, not the vector length, is the authority here.
 *
 * Prior art: the memento corpus solved the same problem by pinning a model and stamping each
 * record (MEMENTO_EMBEDDING_ID / mementoEmbeddingIsCurrent in @bike4mind/common's embedding
 * schema). FabFile chunks carry no such stamp - only the parent FabFile.embeddingModel - so
 * detection has to work from file metadata.
 */

/** Why a loaded chunk was withheld from cosine ranking. */
export type ChunkSkipReason = 'unknownFile' | 'modelMismatch' | 'missingVector' | 'dimensionMismatch';

const SKIP_REASONS: ChunkSkipReason[] = ['unknownFile', 'modelMismatch', 'missingVector', 'dimensionMismatch'];

/** Prose forms, since the report text is read by users and by the model. */
const SKIP_REASON_LABELS: Record<ChunkSkipReason, string> = {
  unknownFile: 'from a file no longer in scope',
  modelMismatch: 'embedded with another model',
  missingVector: 'never embedded',
  dimensionMismatch: 'of a different vector size',
};

/** How many excluded files to name in the report, so a caller can act without dumping the lake. */
const SAMPLE_CAP = 5;

export interface EmbeddingMismatchReport {
  /** Files dropped wholesale before their vectors were loaded (their model is known and foreign). */
  excludedFiles: {
    count: number;
    /** Distinct foreign models, sorted - the actionable "re-embed these" list. */
    models: string[];
    /**
     * Chunk count derived from FabFile.vectorizedChunkCount, NOT a chunk scan: it also counts
     * oversized-unembeddable chunks and is 0 on documents predating the field. Always presented
     * as an estimate.
     */
    estimatedChunks: number;
    sample: { fileId: string; fileName: string; embeddingModel: string }[];
  };
  /** Chunks that were loaded and then withheld. Exact counts. */
  skippedChunks: { total: number; byReason: Record<ChunkSkipReason, number> };
  /**
   * Chunks scored despite having no recorded model, and the files they came from. Advisory only:
   * these are NEVER excluded (see isForeignEmbeddingModel), so their embedding space is unverified.
   */
  unlabeled: { chunks: number; files: number };
  /** A scope/load cap was hit, so the corpus was not fully considered regardless of model. */
  truncated: { chunkCapHit: boolean; fileCapHit: boolean; filesTotal: number | null };
  /**
   * True when content was withheld because it could not be compared - the single flag a consumer
   * branches on. Deliberately NOT set by the scope/load caps in `truncated`: those bound every
   * search of a large lake, so folding them in would flag almost every query on a healthy corpus
   * and bury the signal this flag exists to carry.
   */
  partial: boolean;
}

/**
 * A fresh zeroed report. A factory rather than a shared frozen constant so no two results ever
 * alias the same nested objects.
 */
export function emptyEmbeddingMismatchReport(): EmbeddingMismatchReport {
  return {
    excludedFiles: { count: 0, models: [], estimatedChunks: 0, sample: [] },
    skippedChunks: {
      total: 0,
      byReason: { unknownFile: 0, modelMismatch: 0, missingVector: 0, dimensionMismatch: 0 },
    },
    unlabeled: { chunks: 0, files: 0 },
    truncated: { chunkCapHit: false, fileCapHit: false, filesTotal: null },
    partial: false,
  };
}

/** The subset of FabFile metadata this module reasons about. */
export interface EmbeddingLabeledFile {
  id: string;
  fileName?: string;
  embeddingModel?: string | null;
  vectorizedChunkCount?: number;
  /** Set by the vectorize pipeline. A file without vectors withholds nothing when excluded. */
  vectorized?: boolean;
}

/**
 * Does this file's recorded embedding model positively contradict the query's?
 *
 * Returns false whenever the parent label is absent or blank. FabFile.embeddingModel is
 * `required: false` with NO default, so every file vectorized before the field existed reads as
 * unset - treating "unknown" as "foreign" would silently empty every legacy lake. Exclusion must
 * rest on positive evidence, so an unknown label is always given the benefit of the doubt and the
 * chunk is scored (and counted under `unlabeled`).
 *
 * No case folding: every id in the embedding-model enums is already canonical lowercase, so
 * folding would only mask a genuinely malformed label.
 */
export function isForeignEmbeddingModel(parentModel: string | null | undefined, queryModel: string): boolean {
  const parent = parentModel?.trim();
  if (!parent) return false;
  return parent !== queryModel.trim();
}

/**
 * Split a scoped file set into the files worth loading vectors for and the ones whose model is
 * known-foreign. Partitioning at the FILE level (rather than only per chunk) keeps foreign vectors
 * out of memory entirely and stops them consuming the chunk-load cap, which is unordered and would
 * otherwise let a large off-model file evict matchable chunks.
 */
export function partitionFilesByEmbeddingModel<T extends EmbeddingLabeledFile>(
  files: T[],
  queryModel: string
): { rankable: T[]; foreign: T[] } {
  const rankable: T[] = [];
  const foreign: T[] = [];
  for (const file of files) {
    if (isForeignEmbeddingModel(file.embeddingModel, queryModel)) foreign.push(file);
    else rankable.push(file);
  }
  return { rankable, foreign };
}

/**
 * Pick the embedding model to embed the query with, for callers that infer it from the corpus
 * instead of being told (forced retrieval). Returns the most common model across the candidate
 * files, with UNLABELED files voting for `fallbackModel`.
 *
 * That vote is load-bearing, not a tiebreak nicety. Counting only explicit labels lets a single
 * re-vectorized file decide the query model for a whole lake: 900 legacy unlabeled files plus one
 * newer file at a different width would embed the query at the newcomer's width, and then all 900
 * legacy files fail the width check and get withheld.
 *
 * `fallbackModel` MUST be a model the caller can actually embed with. It is the stand-in for an
 * unset label, so it decides the query model whenever unlabeled files are the plurality - and an
 * unservable choice throws inside the embedding factory, which callers swallow into "no results"
 * (exactly the silent partial this module exists to remove). Pass the caller's own working default
 * rather than a deployment-wide guess: the chunk pipeline stamps the CURRENT `defaultEmbeddingModel`
 * admin setting, which is not necessarily what any given environment resolves to.
 */
export function resolveMajorityEmbeddingModel(
  files: EmbeddingLabeledFile[],
  fallbackModel: SupportedEmbeddingModel
): SupportedEmbeddingModel {
  const tally = new Map<string, number>();
  for (const file of files) {
    const model = file.embeddingModel?.trim() || fallbackModel;
    tally.set(model, (tally.get(model) ?? 0) + 1);
  }
  let winner: string = fallbackModel;
  let best = 0;
  // Insertion order breaks ties, so the first model seen wins a dead heat.
  for (const [model, count] of tally) {
    if (count > best) {
      winner = model;
      best = count;
    }
  }
  return winner as SupportedEmbeddingModel;
}

/**
 * Classify a loaded chunk: a reason to withhold it, or null to score it.
 *
 * Pure and total - it must never throw. Both ranking loops sit inside catch blocks that fall back
 * to silent behavior, which is the very bug this module exists to remove.
 *
 * Check order is deliberate:
 *  1. no parent file: the model check needs one, and an orphan cannot be attributed to any model.
 *  2. foreign model before width: it is the actionable diagnostic (it names the model to re-embed)
 *     where a width mismatch only says the two differ. An off-width foreign chunk trips both.
 *  3. missing vector before width, or `0 !== queryDim` would swallow it into the width bucket.
 *  4. width last, so it means "the label agrees (or is unset) but the vector still cannot be
 *     compared" - i.e. the label lies or the vector is truncated.
 */
export function classifyLoadedChunk(args: {
  vector: number[] | null | undefined;
  queryDim: number;
  parentFile: { embeddingModel?: string | null } | undefined;
  queryModel: string;
}): ChunkSkipReason | null {
  const { vector, queryDim, parentFile, queryModel } = args;
  if (!parentFile) return 'unknownFile';
  if (isForeignEmbeddingModel(parentFile.embeddingModel, queryModel)) return 'modelMismatch';
  if (!vector || vector.length === 0) return 'missingVector';
  if (vector.length !== queryDim) return 'dimensionMismatch';
  return null;
}

export interface EmbeddingMismatchAccumulator {
  /** Record a withheld chunk. */
  skip(reason: ChunkSkipReason): void;
  /** Record a chunk that was scored, so unlabeled-but-included volume is visible. */
  scored(parentFile: { embeddingModel?: string | null } | undefined, fileId: string): void;
  /** Record that a scope/load cap bounded the corpus. */
  truncation(info: { chunkCapHit?: boolean; fileCapHit?: boolean; filesTotal?: number | null }): void;
  report(): EmbeddingMismatchReport;
}

/**
 * Accumulate a report. Seeded with the files already excluded at the file level so the two
 * provenances stay separate: `skippedChunks` is an exact scan count, `excludedFiles.estimatedChunks`
 * is metadata-derived. Collapsing them into one number is what makes such reports untrustworthy.
 */
export function createEmbeddingMismatchAccumulator(
  foreignFiles: EmbeddingLabeledFile[],
  queryModel: string
): EmbeddingMismatchAccumulator {
  const report = emptyEmbeddingMismatchReport();
  const unlabeledFileIds = new Set<string>();

  // Only files that actually hold vectors withheld anything. A file chunked under a previous
  // default whose vectorize job never finished carries no vectors, so reporting it as excluded
  // would claim a partial result where nothing was lost.
  const withheld = foreignFiles.filter(f => f.vectorized !== false || (f.vectorizedChunkCount ?? 0) > 0);

  report.excludedFiles.count = withheld.length;
  report.excludedFiles.models = [
    ...new Set(withheld.map(f => f.embeddingModel?.trim()).filter((m): m is string => !!m)),
  ].sort();
  report.excludedFiles.estimatedChunks = withheld.reduce((sum, f) => sum + (f.vectorizedChunkCount ?? 0), 0);
  report.excludedFiles.sample = withheld.slice(0, SAMPLE_CAP).map(f => ({
    fileId: f.id,
    fileName: f.fileName ?? '',
    embeddingModel: f.embeddingModel?.trim() ?? '',
  }));

  const recomputePartial = () => {
    report.partial = report.excludedFiles.count > 0 || report.skippedChunks.total > 0;
  };
  recomputePartial();

  return {
    skip(reason) {
      report.skippedChunks.total += 1;
      report.skippedChunks.byReason[reason] += 1;
      recomputePartial();
    },
    scored(parentFile, fileId) {
      if (parentFile?.embeddingModel?.trim()) return;
      report.unlabeled.chunks += 1;
      unlabeledFileIds.add(fileId);
      report.unlabeled.files = unlabeledFileIds.size;
    },
    truncation(info) {
      if (info.chunkCapHit !== undefined) report.truncated.chunkCapHit = info.chunkCapHit;
      if (info.fileCapHit !== undefined) report.truncated.fileCapHit = info.fileCapHit;
      if (info.filesTotal !== undefined) report.truncated.filesTotal = info.filesTotal;
      recomputePartial();
    },
    report() {
      return report;
    },
  };
}

/**
 * One human sentence describing what was withheld, or null when there is nothing to report.
 * Single wording source for the API response, the chat status line and the quest warning, so the
 * three cannot describe the same event differently. The chat tool adds its own instruction to the
 * model on top of this.
 *
 * Returns null unless something was actually withheld. In particular an unlabeled-but-included
 * corpus is NOT a partial result: most legacy lakes are entirely unlabeled, so reporting them
 * here would fire a warning on nearly every search and teach the reader to ignore it. That case
 * is a log-level concern (see the callers' unlabeled warn); it only joins this text when there is
 * a genuine withholding to give it context.
 */
export function describeEmbeddingMismatch(
  report: EmbeddingMismatchReport | undefined,
  queryModel: string
): string | null {
  if (!report || !report.partial) return null;
  const sentences: string[] = [];

  if (report.excludedFiles.count > 0) {
    const models = report.excludedFiles.models.join(', ') || 'another model';
    sentences.push(
      `Partial knowledge-base results: ${report.excludedFiles.count} file(s) (about ${report.excludedFiles.estimatedChunks} chunks) were excluded because they are embedded with ${models}, not the query's ${queryModel}. Re-embed those files to include them.`
    );
  }
  if (report.skippedChunks.total > 0) {
    const reasons = SKIP_REASONS.filter(r => report.skippedChunks.byReason[r] > 0)
      .map(r => `${report.skippedChunks.byReason[r]} ${SKIP_REASON_LABELS[r]}`)
      .join(', ');
    sentences.push(`${report.skippedChunks.total} loaded chunk(s) could not be compared (${reasons}).`);
  }
  if (report.truncated.chunkCapHit || report.truncated.fileCapHit) {
    const what = [report.truncated.fileCapHit ? 'files' : null, report.truncated.chunkCapHit ? 'chunks' : null]
      .filter(Boolean)
      .join(' and ');
    const total = report.truncated.filesTotal !== null ? ` (${report.truncated.filesTotal} files match in total)` : '';
    sentences.push(`The search also hit its ${what} cap${total}, so the corpus was not fully considered.`);
  }
  if (report.unlabeled.chunks > 0) {
    sentences.push(
      `${report.unlabeled.chunks} chunk(s) in ${report.unlabeled.files} file(s) have no recorded embedding model and were included as-is, so their embedding space is unverified.`
    );
  }

  return sentences.length > 0 ? sentences.join(' ') : null;
}
