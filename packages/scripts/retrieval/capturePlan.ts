/**
 * The decisions a capture makes before it spends anything: what it will cost, and which chunks are
 * honestly comparable in the arm being captured.
 *
 * Split out from `capture-embeddings.ts` so both are testable without credentials. That entrypoint
 * has to connect to Mongo and hold a provider key, so nothing in it can run in CI - which is
 * exactly why every judgement that can silently corrupt a result lives here instead: the cost
 * preflight (which decides whether to spend), the stored-vector stamp gate and `modalLength` (which
 * together decide what gets scored and what is reported as a width mismatch), and the two guards on
 * what the provider hands back. What stays over there is the orchestration: connect, read, write.
 * Same split the rest of this directory already uses - pure modules plus one credentialed entrypoint.
 */

import {
  getEmbeddingModelCost,
  hasPublishedEmbeddingRate,
  isSupportedEmbeddingModel,
  type SupportedEmbeddingModel,
} from '@bike4mind/common';
import {
  OPENAI_EFFECTIVE_TOKEN_LIMIT,
  OPENAI_MAX_INPUTS_PER_REQUEST,
  OPENAI_MAX_TOKENS_PER_INPUT,
  type EmbeddingService,
} from '@bike4mind/fab-pipeline';
import { dataLakeService } from '@bike4mind/services';
import { isRetrievalExcluded, type RetrievalExclusionOptions } from '@bike4mind/utils/retrievalExclusion';

export type ModelCostPlan = {
  model: string;
  tokens: number;
  /** API requests the shipped batcher will issue - see `countBatches`. */
  batches: number;
  usd: number;
  /**
   * The model has no published rate in the shipped price table. `getEmbeddingModelCost` settles
   * such a model at $0 with a console alarm, which as a PREFLIGHT would read as "this is free" -
   * the one lie a spend gate must not tell. Surfaced as a flag so the caller can refuse instead.
   */
  unpriced: boolean;
};

export type CapturePlan = {
  chunks: number;
  perModel: ModelCostPlan[];
  totalUsd: number;
  /** True when any model in the plan is unpriced, so `totalUsd` understates the real spend. */
  anyUnpriced: boolean;
};

/**
 * Requests the shipped batcher will issue for these chunks.
 *
 * It splits on BOTH ceilings, and on a corpus of long passages the TOKEN one is what actually binds:
 * 2048 chunks of ~550 tokens is over a million, well past the per-request limit. Greedy in input
 * order, matching `createBatches`, and off the limits that module exports - so the numbers cannot
 * drift, only the shape of the loop can.
 */
function countBatches(tokenCounts: readonly number[]): number {
  let batches = 0;
  let inputs = 0;
  let tokens = 0;
  for (const count of tokenCounts) {
    if (inputs === 0 || inputs >= OPENAI_MAX_INPUTS_PER_REQUEST || tokens + count > OPENAI_EFFECTIVE_TOKEN_LIMIT) {
      batches++;
      inputs = 0;
      tokens = 0;
    }
    inputs++;
    tokens += count;
  }
  return batches;
}

/**
 * The token count to plan and guard one chunk with.
 *
 * `FabFileChunk.tokenCount` is declared required (packages/database/src/models/content/FabFileModel.ts),
 * so the fallback is unreachable against real data - it covers a hand-built chunk only. It matches the
 * shipped fallback in `calculateTokenCounts` (chars/3, OpenAIEmbeddingService), which deliberately
 * OVERestimates: this number feeds both the spend quote and `findOversizedChunks`, so a firing must
 * over-quote and over-report rather than under-quote either. It lives here with a test because it is a
 * judgement that can silently corrupt a spend decision.
 */
export const chunkTokenCount = (tokenCount: number | null | undefined, text: string): number =>
  tokenCount ?? Math.ceil(text.length / 3);

/**
 * Chunks the provider will refuse, named so the operator can fix the right one.
 *
 * `generateEmbeddingBatch` validates the per-input ceiling before it issues a request, so no money
 * is lost - but it throws `Input at index N exceeds ...`, an index into an array the operator never
 * sees, and it throws AFTER they read the cost and typed --yes. Same reasoning as
 * `assertOnePerInput`, applied to the case that predicate cannot cover.
 *
 * Unreachable on prod's ~550-token passages; reachable on a lake with a large chunk-size setting,
 * which the runbook does point this at.
 */
export function findOversizedChunks(
  chunks: readonly { chunkId: string; tokenCount: number }[]
): { chunkId: string; tokenCount: number }[] {
  return chunks.filter(c => c.tokenCount > OPENAI_MAX_TOKENS_PER_INPUT);
}

/**
 * What this capture will cost, priced from the SHIPPED rate table (`getEmbeddingModelCost`) rather
 * than from any number written down here. Prices move; a literal in a script goes stale silently
 * and a preflight that under-quotes is worse than no preflight at all.
 *
 * Query embeddings are deliberately not modelled: 30 probe questions against hundreds of ~550-token
 * chunks is rounding error, and inventing a second estimate would suggest a precision this does not
 * have. The chunk total is the number that decides whether to run.
 */
export function planCapture(chunkTokenCounts: readonly number[], models: readonly string[]): CapturePlan {
  const tokens = chunkTokenCounts.reduce((sum, n) => sum + n, 0);
  const batches = countBatches(chunkTokenCounts);

  const perModel = models.map(model => ({
    model,
    tokens,
    batches,
    usd: getEmbeddingModelCost(model, tokens),
    // Asked of the price table directly rather than inferred from a $0 result: a locally-hosted
    // embedder priced at an explicit 0 and a model with no rate at all both cost $0, and only the
    // second one must stop the run.
    unpriced: !hasPublishedEmbeddingRate(model),
  }));

  return {
    chunks: chunkTokenCounts.length,
    perModel,
    totalUsd: perModel.reduce((sum, m) => sum + m.usd, 0),
    anyUnpriced: perModel.some(m => m.unpriced),
  };
}

export function formatCapturePlan(plan: CapturePlan): string {
  // No model in the plan means --reuse-stored-vectors. Rendering the chunk count would quote chunks
  // that will NOT be embedded, and a $0.0000 total would omit the probe queries the reuse arm does
  // pay for. Both halves mislead, in opposite directions, in the spend gate's own output.
  if (plan.perModel.length === 0) {
    return 'reusing stored vectors: no chunk is embedded, only the probe queries (rounding error).';
  }
  const lines = plan.perModel.map(
    m =>
      `  ${m.model.padEnd(28)} ${String(m.tokens).padStart(10)} tokens  ${String(m.batches).padStart(4)} batches  ` +
      (m.unpriced ? 'UNPRICED - no published rate, real cost unknown' : `$${m.usd.toFixed(4)}`)
  );
  return [
    `chunks to embed      : ${plan.chunks}`,
    ...lines,
    plan.anyUnpriced
      ? 'TOTAL                : UNKNOWN - at least one model has no published rate'
      : `TOTAL                : $${plan.totalUsd.toFixed(4)}`,
  ].join('\n');
}

/** A stored chunk as read back from Mongo, with the embedding label of its parent file. */
export type StoredChunk = {
  chunkId: string;
  docId: string;
  text: string;
  vector: number[];
  /** `FabFile.embeddingModel` of the parent. Absent on every file vectorized before the field existed. */
  parentEmbeddingModel?: string | null;
};

export type ReuseSelection = {
  reusable: StoredChunk[];
  /**
   * Chunks excluded, and why: the shipped `ChunkSkipReason` vocabulary
   * (b4m-core/services/src/dataLakeService/embeddingMismatch.ts) plus `unlabeled`, which has no
   * production counterpart - retrieval SCORES an unlabeled chunk rather than skipping it, so only a
   * measurement needs the reason. `unknownFile` cannot arise here: chunks are read by parent file id.
   */
  excluded: { unlabeled: number; modelMismatch: number; missingVector: number; dimensionMismatch: number };
  /** Distinct parent documents dropped entirely, for the `embedding_mismatch` line of the report. */
  excludedDocs: number;
};

/**
 * Pick the stored vectors that genuinely belong to `model`'s space, for the `--reuse-stored-vectors`
 * baseline arm.
 *
 * DELIBERATELY STRICTER than `isForeignEmbeddingModel`, in the same direction and for the same
 * reason as the corpus defer gate and `isFabFileCitable`: an UNLABELED chunk is excluded here, where
 * the shared predicate scores it. Retrieval gives an unknown label the benefit of the doubt because
 * refusing would empty every legacy lake and lose a user their content. A measurement has the
 * opposite duty - what produced an unlabeled vector is genuinely unknown, and folding unknown
 * vectors into a baseline is how a band gets measured across two embedding spaces at once and
 * reported as one number.
 *
 * The rule itself is not re-implemented: the foreign case calls the shipped predicate, so this adds
 * no eighth copy of the exact-match rule to keep in lockstep (see the CANONICAL LIST in
 * b4m-core/services/src/dataLakeService/embeddingMismatch.ts).
 */
export function selectReusableChunks(
  chunks: readonly StoredChunk[],
  model: string,
  expectedDims?: number
): ReuseSelection {
  const excluded = { unlabeled: 0, modelMismatch: 0, missingVector: 0, dimensionMismatch: 0 };
  const reusable: StoredChunk[] = [];
  const keptDocs = new Set<string>();
  const allDocs = new Set<string>();

  for (const chunk of chunks) {
    allDocs.add(chunk.docId);
    const label = chunk.parentEmbeddingModel?.trim();
    if (!label) {
      excluded.unlabeled++;
      continue;
    }
    if (dataLakeService.isForeignEmbeddingModel(label, model)) {
      excluded.modelMismatch++;
      continue;
    }
    if (!chunk.vector || chunk.vector.length === 0) {
      excluded.missingVector++;
      continue;
    }
    // Width last, so it means "the label agrees but the vector still cannot be compared" - i.e. the
    // label lies or the vector was truncated. Same check order as classifyLoadedChunk.
    if (expectedDims !== undefined && chunk.vector.length !== expectedDims) {
      excluded.dimensionMismatch++;
      continue;
    }
    reusable.push(chunk);
    keptDocs.add(chunk.docId);
  }

  return { reusable, excluded, excludedDocs: [...allDocs].filter(d => !keptDocs.has(d)).length };
}

/** Total chunks dropped, for the fixture's `chunksExcluded`. */
export const totalExcluded = (excluded: ReuseSelection['excluded']): number =>
  excluded.unlabeled + excluded.modelMismatch + excluded.missingVector + excluded.dimensionMismatch;

/**
 * Validate model ids against the shipped registry and narrow them, before anything is spent.
 *
 * An unrecognised id fails CLOSED several layers down (the embedding factory throws on an unknown
 * provider), but only after the capture has connected, scanned the lake and read every chunk. This
 * turns a late opaque failure into an immediate one that names the offending value - and returns the
 * narrowed type, so the caller does not restate the check with a cast.
 */
export function parseSupportedModels(models: readonly string[]): SupportedEmbeddingModel[] {
  const unknown = models.filter(m => !isSupportedEmbeddingModel(m));
  if (unknown.length > 0) {
    throw new Error(`Unsupported embedding model(s): ${unknown.join(', ')}. See SupportedEmbeddingModelSchema.`);
  }
  return [...models] as SupportedEmbeddingModel[];
}

/**
 * The FabFile fields the capture's reachability filter reads - a projection, so the caller can fetch
 * only these. Mirrors `CitableFileFields` (apps/client/server/memory/lakeSourceReachability.ts) minus
 * `embeddingModel`, for the reason `isCapturableFile` explains.
 */
export type CapturableFileFields = {
  deletedAt?: Date | null;
  archivedAt?: Date | null;
  chunkCount?: number | null;
  vectorizedChunkCount?: number | null;
} & Parameters<typeof isRetrievalExcluded>[0];

/**
 * Can the served retrieval path actually reach this file's chunks?
 *
 * MUST STAY IN SYNC with `isFabFileCitable` (apps/client/server/memory/lakeSourceReachability.ts),
 * which carries the same note and names the corpus defer gate as its own twin. This is that
 * predicate MINUS its `embeddingModel === queryEmbeddingModel` clause, because the arms deliberately
 * vary the model - the stamp comparison is `selectReusableChunks`'s job and belongs to one arm, not
 * to the file set every arm shares.
 *
 * The capture enumerates a lake with `findIdsByDataLakeTag`, which is the LIFECYCLE-SWEEP reader: it
 * returns every id the lake has ever held, with no archivedAt/deletedAt condition (see its index
 * docblock in FabFileModel). Without this filter an archived or half-vectorized file is embedded,
 * paid for, and scored into the band - and `scoreBand` pools min/max across every query's top-k, so
 * one unreachable chunk moves the headline number that production's `search_knowledge_base` would
 * never have returned.
 *
 * KNOWN OVERSTATEMENT, on one file only. `vectorizedChunkCount >= chunkCount` withholds a partially
 * vectorized file, and `partitionByIndexAvailability` (../../../b4m-core/services/src/dataLakeService/
 * retrievalUnavailable.ts) says such a file really does rank its embedded passages, because the read
 * filters `vector: {$exists, $ne: []}` per CHUNK. The corpus defer gate reads it the other way, and
 * can afford to. So `filesUnreachable` is an upper bound on what production withholds, and the band
 * is measured over a marginally narrower corpus.
 *
 * Sharing the filter across arms makes the drop comparison-neutral for a MEAN, which is not what the
 * headline is: band width is `max - min`, an extreme, and the withheld stratum is not random -
 * partially vectorized files skew long, and this comparison exists because model behaviour may
 * interact with length. So the honest rider is narrower than "unaffected": the comparison is
 * unbiased when `filesUnreachable` is 0, which every arm block prints. On the corpus this targets
 * that count is 0 (the prod probe recorded zero missing vectors and zero paused or indexing files).
 * Read the counter before reading the widths against each other.
 *
 * `opts` is empty in practice: a capture has no session, so there is no retrieval filter to apply and
 * that arm is a no-op today. The call stays because the shipped predicate makes it, and a filter that
 * silently omits one of the four conditions is how these two drift.
 */
export function isCapturableFile(file: CapturableFileFields, opts: RetrievalExclusionOptions = {}): boolean {
  if (file.deletedAt || file.archivedAt) return false;
  if (isRetrievalExcluded(file, opts)) return false;
  const chunks = file.chunkCount ?? 0;
  return chunks > 0 && (file.vectorizedChunkCount ?? 0) >= chunks;
}

/** An embedding service that also exposes the provider's batch path (OpenAI's does). */
type BatchEmbeddingService = EmbeddingService & {
  generateEmbeddingBatch(texts: string[]): Promise<number[][]>;
};

const hasBatchPath = (service: EmbeddingService): service is BatchEmbeddingService =>
  'generateEmbeddingBatch' in service && typeof service.generateEmbeddingBatch === 'function';

/**
 * Embed via the provider's batch path when it has one, else the one-at-a-time contract every
 * provider does implement. `generateEmbeddingBatch` lives on the OpenAI service rather than on the
 * abstract `EmbeddingService`, so this narrows rather than casts.
 *
 * `tokenCounts` is deliberately NOT passed through. Absent them the batcher recalculates with
 * tiktoken, which is strictly better than the counts this harness holds (stored by an unknown
 * tokenizer, or the capture's own chars/4 fallback) - so passing them would look like an
 * optimization while making the batch split less accurate.
 */
export async function embedAll(service: EmbeddingService, texts: string[]): Promise<number[][]> {
  if (hasBatchPath(service)) return service.generateEmbeddingBatch(texts);
  const out: number[][] = [];
  for (const text of texts) out.push(await service.generateEmbedding(text));
  return out;
}

/**
 * The batcher must return exactly one vector per input, in order. The shipped OpenAI batcher does
 * (`generateEmbeddingBatch` index-places into a pre-sized array), so this guards an unlikely path -
 * but the failure would land AFTER the spend, as an opaque zod error naming no chunk, because
 * `JSON.stringify` drops an `undefined` vector entirely.
 */
export function assertOnePerInput(vectors: number[][], expected: number, what: string): void {
  if (vectors.length !== expected || vectors.some(v => !Array.isArray(v) || v.length === 0)) {
    throw new Error(`Embedding ${what}: expected ${expected} vectors, got ${vectors.length} (some may be empty).`);
  }
}

/**
 * The width the stored corpus is actually at: the most common vector length in the set.
 *
 * Reading the width off the corpus instead of assuming one is what makes a partly re-embedded lake
 * surface as `dimensionMismatch` rather than scoring across two spaces as noise. It also DECIDES
 * that classification, which is why it lives here with a test rather than in the credentialed
 * entrypoint.
 *
 * Ties break on the WIDER width. Not because it is more correct - on an exact 50/50 split there is
 * no majority to find - but because the alternative was insertion order, which is the lake read's
 * unsorted return order, which is Mongo document order. Either choice sends half the corpus to
 * `dimensionMismatch`, and the excluded counters plus the differing-chunk-sets note both report
 * that; a nondeterministic choice is the one thing that cannot be reported.
 *
 * `undefined` on empty input means "no width guard", which is the right answer: the caller got here
 * with no labelled vector at all, and its next selection pass is what reports that.
 */
export function modalLength(lengths: readonly number[]): number | undefined {
  const tally = new Map<number, number>();
  for (const n of lengths) tally.set(n, (tally.get(n) ?? 0) + 1);
  let best: number | undefined;
  let bestCount = 0;
  for (const [len, count] of tally) {
    if (count > bestCount || (count === bestCount && best !== undefined && len > best)) {
      best = len;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Split a list into reads small enough for the planner.
 *
 * `findVectorsByFabFileIds`' docblock is the reason there is a number here at all: up to a couple
 * hundred ids the `{ fabFileId: 1, _id: 1 }` index serves an `$in` as a non-blocking SORT_MERGE, and
 * past the planner's $in-explosion limit it falls back to an `_id` range scan. A whole production
 * lake in one `$in` is exactly that fallback.
 */
export function toBatches<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error(`Batch size must be at least 1, got ${size}.`);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push([...items.slice(i, i + size)]);
  return batches;
}

/**
 * Drain a keyset-paged read to completion.
 *
 * Lives here rather than in the entrypoint because a paging bug is a RESULT-corrupting bug of the
 * kind this module exists to hold: a cursor that stops early drops chunks from the corpus silently,
 * and the capture would report the smaller number as if it were the lake. The non-advancing-cursor
 * throw covers the other half - a reader that returns a full page without moving the cursor would
 * otherwise spin forever on a credentialed run.
 */
export async function readAllPages<T extends { id: string }>(
  readPage: (afterId?: string) => Promise<T[]>,
  pageSize: number
): Promise<T[]> {
  const all: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await readPage(after);
    all.push(...page);
    if (page.length < pageSize) return all;
    const last = page[page.length - 1].id;
    if (last === after) throw new Error(`Paged read returned a full page without advancing past ${last}.`);
    after = last;
  }
}
