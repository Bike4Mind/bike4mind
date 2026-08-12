import { isSupportedEmbeddingModel, type SupportedEmbeddingModel } from '@bike4mind/common';

/**
 * Detection and accounting for chunks that cannot be meaningfully cosine-compared to a query
 * embedding because they were embedded with a different model.
 *
 * Shared by BOTH data-lake ranking loops - semanticDataLakeSearch's rankChunksForFiles (the
 * endpoint, the chat KB tool and the RLM tools) and KnowledgeRetrievalFeature's forced-retrieval
 * injection - so the two apply one definition of "cannot be compared". They still resolve the
 * QUERY model differently (the tool reads the admin setting directly; forced retrieval votes
 * across the corpus and falls back to that same admin setting when unlabeled files decide it),
 * and that choice is what any given chunk is then judged against.
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

/**
 * The short decoration appended to a live status line when a search was partial. Exported so
 * every caller that decorates a status line this way shares one phrase instead of hand-copying
 * it; the substantive sentence comes from describeEmbeddingMismatch below. Forced retrieval
 * writes its own promptMeta sentence via reportCoverage and does not use this suffix.
 */
export const PARTIAL_RESULTS_STATUS_SUFFIX = ' - partial results, some content could not be searched';

/** Prose forms, since the report text is read by users and by the model. */
const SKIP_REASON_LABELS: Record<ChunkSkipReason, string> = {
  unknownFile: 'from a file no longer in scope',
  modelMismatch: 'embedded with another model',
  missingVector: 'never embedded',
  dimensionMismatch: 'of a different vector size',
};

/** How many excluded files to name in the report, so a caller can act without dumping the lake. */
const SAMPLE_CAP = 5;

/**
 * MUST STAY IN SYNC with serializeEmbeddingMismatch in
 * apps/client/pages/api/data-lakes/semantic-search.ts, which maps this to the wire by hand. A
 * field added here reaches no HTTP caller until that mapper is updated too.
 */
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
  /**
   * Files whose vectors are in a DIFFERENT embedding space than the query but were still SEARCHED,
   * via that model's own ANN index (see alternateModelAnn.ts). Deliberately NOT part of
   * `excludedFiles` and deliberately does NOT raise `partial`: nothing was withheld. Reported so a
   * reader can tell "this lake is mixed-model and we covered it" apart from "this lake is
   * single-model".
   *
   * This is COVERAGE, not "returned a visible result": a file counts as served once its ANN query
   * returns any raw hit, before `minScore` is applied (see excludedForeignFiles in
   * semanticDataLakeSearch.ts). A minScore floor tuned for the primary model's cosine scale can
   * still filter every one of an alternate model's rows out of the final results - see the
   * cross-model raw-cosine caveat where the merge happens.
   */
  alternateModelServed: { files: number; models: string[] };
  /**
   * The query embedding came back empty, so nothing could be compared at all. Distinguished from
   * a mismatch because otherwise the report reads as a normal search with some exclusions, and
   * points the reader at re-embedding files when the embedder is what actually failed.
   */
  queryEmbeddingFailed: boolean;
  /**
   * True when content was withheld because its embedding space could not be compared - the single
   * flag a consumer branches on.
   *
   * Only `excludedFiles`, `modelMismatch` and `dimensionMismatch` raise it. Everything else the
   * report counts is deliberately excluded, because each is either permanent or ordinary and would
   * make the flag fire on a healthy corpus forever:
   *  - scan truncation (see SemanticSearchScanAccounting.truncated, which owns that signal):
   *    every search of a large lake hits a budget.
   *  - `unlabeled`: those chunks WERE searched, and most legacy lakes are entirely unlabeled.
   *  - `missingVector`: a chunk with no vector was never embedded, which is not a mismatch. Some
   *    are permanently unembeddable (oversized past the model's context window - a terminal state,
   *    see countTerminalChunks), so counting them would flag such a lake on every turn with no
   *    remedy available to the user.
   *  - `unknownFile`: an orphan chunk cannot be attributed to a model, so nothing can be claimed
   *    about whether it was comparable.
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
    alternateModelServed: { files: 0, models: [] },
    queryEmbeddingFailed: false,
    partial: false,
  };
}

/** The subset of FabFile metadata this module reasons about. */
export interface EmbeddingLabeledFile {
  id: string;
  fileName?: string;
  embeddingModel?: string | null;
  /**
   * Terminal chunk count maintained by the vectorize pipeline. This is the only trustworthy
   * "has vectors" signal: `FabFile.vectorized` is stamped `chunks.length > 0` at CHUNK time
   * (fabFileService/chunk.ts), before any vector exists, so it reads true for a file whose
   * vectorize job never ran or failed.
   */
  vectorizedChunkCount?: number;
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
 * No case folding, and the exact match is LOAD-BEARING rather than incidental - so it is worth
 * being precise about what actually backs it, because the embedding-model enums do not. The
 * `FabFile.embeddingModel` field this reads is a bare `String` with no `enum` and no `lowercase`
 * (packages/database FabFileSchema), so canonical-lowercase storage rests on the write path, in
 * two halves:
 *  - the QUERY model can only be a canonical id: `defaultEmbeddingModel` is declared with an
 *    `options` list, which makeStringSetting turns into a membership check that the settings
 *    update route runs on every admin write.
 *  - the STORED label has exactly one writer - chunkFabfile (fabFileService/chunk.ts) - whose
 *    `chunkFileSchema` validates it against SupportedEmbeddingModelSchema before the file is
 *    saved. Chunk labels are stamped from that same validated value by the vectorize handler and by
 *    the chunk-model backfill script (packages/scripts/datalake).
 *
 * Folding here would therefore mask a malformed label without buying anything, and a malformed
 * label is exactly what should stay visible. An unrecognized id also already fails CLOSED one
 * layer down: fab-pipeline keys its Atlas index registry with a Map, so an unknown model yields
 * no index target and the search degrades to the brute-force scan instead of querying a bogus one.
 *
 * CANONICAL LIST - three other readers compare this same field to the query's as an exact string,
 * and each holds its OWN copy of the rule rather than calling this function:
 *  - the corpus defer gate (llm/ChatCompletionProcess.ts),
 *  - isFabFileCitable (apps/client/server/memory/lakeSourceReachability.ts),
 *  - the Atlas `$vectorSearch` `filter: { embeddingModel }` clause (packages/database
 *    FabFileChunkRepository.vectorSearch).
 *
 * So relaxing the comparison HERE does not propagate to them - it makes the four DIVERGE, which is
 * the actual hazard: the rule has to move in lockstep across all four or not at all. The first two
 * are also deliberately STRICTER than this predicate (they count an unlabeled file as unreachable
 * where this one scores it), and their own comments explain why the three must not be consolidated.
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
 *
 * Deliberately independent of `groupFilesByEmbeddingModel` below - ChatCompletionFeatures.ts's
 * forced-retrieval path calls this function directly and must stay structurally insulated from
 * the multi-model ANN grouping used by the Atlas/OpenSearch cutover; do not refactor one in terms
 * of the other.
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

export interface EmbeddingModelGroups<T> {
  /** Query-model files, plus unlabeled/blank-labeled ones (same membership as `partitionFilesByEmbeddingModel`'s `rankable`). */
  primary: T[];
  /** One bucket per distinct foreign label actually present, in first-appearance order. */
  alternates: Array<{ model: string; files: T[] }>;
}

/**
 * Group a scoped file set by every distinct embeddingModel actually present, not just
 * query-model-vs-foreign. Feeds the Atlas/OpenSearch multi-model ANN cutover (see
 * alternateModelAnn.ts), which gives each alternate model its own ANN query instead of dropping
 * it outright. `primary` is byte-identical to `partitionFilesByEmbeddingModel(...).rankable` on
 * the same input - see the anti-drift test.
 *
 * Deliberately independent of `partitionFilesByEmbeddingModel` above - see that function's
 * comment. Do not implement one in terms of the other.
 */
export function groupFilesByEmbeddingModel<T extends EmbeddingLabeledFile>(
  files: T[],
  queryModel: string
): EmbeddingModelGroups<T> {
  const primary: T[] = [];
  // Keyed on the trimmed label so ' voyage-3 ' and 'voyage-3' collapse into one bucket, matching
  // isForeignEmbeddingModel's own trim. No case folding, for the same reason isForeignEmbeddingModel
  // doesn't fold: every registered model id is already canonical lowercase, so a case variant is a
  // genuinely different (unsupported) label, not the same model spelled differently.
  const alternatesByModel = new Map<string, T[]>();
  for (const file of files) {
    if (!isForeignEmbeddingModel(file.embeddingModel, queryModel)) {
      primary.push(file);
      continue;
    }
    // isForeignEmbeddingModel already returned true for a non-blank label, so the trim here can't
    // produce an empty key.
    const key = (file.embeddingModel as string).trim();
    const bucket = alternatesByModel.get(key);
    if (bucket) bucket.push(file);
    else alternatesByModel.set(key, [file]);
  }
  return { primary, alternates: [...alternatesByModel].map(([model, bucketFiles]) => ({ model, files: bucketFiles })) };
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
  const tally = new Map<SupportedEmbeddingModel, number>();
  for (const file of files) {
    const label = file.embeddingModel?.trim();
    // An unrecognized label is treated as unlabeled rather than tallied. Letting a corrupt value
    // win the vote would hand it to createEmbeddingService, which throws on an unknown provider,
    // and the callers swallow that into an empty result: the silent partial this module removes.
    const model = label && isSupportedEmbeddingModel(label) ? label : fallbackModel;
    tally.set(model, (tally.get(model) ?? 0) + 1);
  }
  let winner: SupportedEmbeddingModel = fallbackModel;
  let best = 0;
  // Insertion order breaks ties, so the first model seen wins a dead heat.
  for (const [model, count] of tally) {
    if (count > best) {
      winner = model;
      best = count;
    }
  }
  return winner;
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

/**
 * Classify an Atlas `$vectorSearch` hit: a reason to withhold it, or null to include it.
 *
 * Far shorter than classifyLoadedChunk because most of that function's job is already done by
 * the query itself: the `filter: { embeddingModel: model }` clause means Atlas physically cannot
 * return a chunk embedded under a different model, and a returned hit always carries a vector
 * (there is nothing to compare a missing one against). The one thing the query CANNOT guarantee
 * is that the file is still in the caller's current scope - `fileById` is built from an
 * independent scope resolution, and a hit for a file that fell out of it must still be dropped.
 */
export function classifyAnnHit(args: { parentFile: unknown }): ChunkSkipReason | null {
  return args.parentFile ? null : 'unknownFile';
}

export interface EmbeddingMismatchAccumulator {
  /** Record a withheld chunk. */
  skip(reason: ChunkSkipReason): void;
  /** Record a chunk that was scored, so unlabeled-but-included volume is visible. */
  scored(parentFile: { embeddingModel?: string | null } | undefined, fileId: string): void;
  /** Record that the query could not be embedded, so no comparison happened. */
  queryEmbeddingFailed(): void;
  /** Record files an alternate-model ANN query actually served (see alternateModelAnn.ts). Never touches `partial`. */
  alternateModelServed(files: number, models: string[]): void;
  report(): EmbeddingMismatchReport;
}

/**
 * Accumulate a report. Seeded with the files already excluded at the file level so the two
 * provenances stay separate: `skippedChunks` is an exact scan count, `excludedFiles.estimatedChunks`
 * is metadata-derived. Collapsing them into one number is what makes such reports untrustworthy.
 *
 * `foreignFiles` must already have any alternate-model-ANN-served files removed by the caller -
 * see `excludedForeignFiles` in semanticDataLakeSearch.ts, which filters on the served set before
 * this is ever constructed. Recomputing `excludedFiles` after the fact here would have to keep
 * `count`/`models`/`estimatedChunks`/the sample consistent with a second filter pass; doing it
 * once, before construction, is simpler and cannot drift.
 */
export function createEmbeddingMismatchAccumulator(
  foreignFiles: EmbeddingLabeledFile[],
  queryModel: string
): EmbeddingMismatchAccumulator {
  const report = emptyEmbeddingMismatchReport();
  const unlabeledFileIds = new Set<string>();

  // Only files that actually hold vectors withheld anything. A file chunked under a previous
  // default whose vectorize job never finished carries no vectors, so reporting it as excluded
  // would claim a partial result where nothing was lost - and right after an admin model switch
  // that is a common state, not a rare one. Keyed on the terminal count rather than `vectorized`
  // for the reason on the field above; any file carrying an embeddingModel was chunked by the
  // pipeline that maintains this count, so it is reliable for the foreign files filtered here.
  const withheld = foreignFiles.filter(f => (f.vectorizedChunkCount ?? 0) > 0);

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
    const mismatched = report.skippedChunks.byReason.modelMismatch + report.skippedChunks.byReason.dimensionMismatch;
    report.partial = report.queryEmbeddingFailed || report.excludedFiles.count > 0 || mismatched > 0;
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
    queryEmbeddingFailed() {
      report.queryEmbeddingFailed = true;
      recomputePartial();
    },
    alternateModelServed(files, models) {
      report.alternateModelServed.files += files;
      report.alternateModelServed.models = [...new Set([...report.alternateModelServed.models, ...models])].sort();
      // Deliberately no recomputePartial() call - nothing was withheld, so this must never raise `partial`.
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
  // The embedder failing is not a mismatch, and naming files to re-embed would send the reader
  // after the wrong thing entirely.
  if (report.queryEmbeddingFailed) {
    return `Knowledge-base search could not run: the query could not be embedded with ${queryModel}, so no content was compared.`;
  }
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
  if (report.unlabeled.chunks > 0) {
    sentences.push(
      `${report.unlabeled.chunks} chunk(s) in ${report.unlabeled.files} file(s) have no recorded embedding model and were included as-is, so their embedding space is unverified.`
    );
  }
  // Only reachable when `sentences` already has something in it (this function returns null above
  // when `report.partial` is false), so this positive-coverage note always rides alongside a
  // genuine withholding above it - it does not by itself trigger the "partial results" framing a
  // caller wraps this text in.
  if (report.alternateModelServed.files > 0) {
    const models = report.alternateModelServed.models.join(', ');
    sentences.push(
      `${report.alternateModelServed.files} file(s) embedded with ${models} were searched through their own vector index.`
    );
  }

  return sentences.length > 0 ? sentences.join(' ') : null;
}
