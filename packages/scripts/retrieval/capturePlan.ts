/**
 * The decisions a capture makes before it spends anything: what it will cost, and which chunks are
 * honestly comparable in the arm being captured.
 *
 * Split out from `capture-embeddings.ts` so both are testable without credentials. That entrypoint
 * has to connect to Mongo and hold a provider key, so nothing in it can run in CI - which is
 * exactly why the two judgements that can silently corrupt a result live here instead: the cost
 * preflight (which decides whether to spend) and the stored-vector stamp gate (which decides what
 * gets scored). Same split the rest of this directory already uses - pure modules plus one
 * credentialed entrypoint.
 */

import {
  getEmbeddingModelCost,
  isSupportedEmbeddingModel,
  OllamaEmbeddingModel,
  type SupportedEmbeddingModel,
} from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import { isRetrievalExcluded, type RetrievalExclusionOptions } from '@bike4mind/utils/retrievalExclusion';

/** OpenAI's per-request input ceiling - what the shipped batcher splits on. */
const MAX_INPUTS_PER_REQUEST = 2048;

export type ModelCostPlan = {
  model: string;
  tokens: number;
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
 * Ollama embedders run on the operator's own hardware and are priced at an explicit 0, so a $0
 * total is the truth for them rather than a missing rate. Everything else costing exactly 0 for a
 * non-zero token count means the price table has no entry.
 */
const isKeylessLocalModel = (model: string): boolean =>
  Object.values(OllamaEmbeddingModel).includes(model as OllamaEmbeddingModel);

/**
 * What this capture will cost, priced from the SHIPPED rate table (`getEmbeddingModelCost`) rather
 * than from any number written down here. Prices move; a literal in a script goes stale silently
 * and a preflight that under-quotes is worse than no preflight at all.
 *
 * Query embeddings are deliberately not modelled: 31 probe questions against hundreds of ~550-token
 * chunks is rounding error, and inventing a second estimate would suggest a precision this does not
 * have. The chunk total is the number that decides whether to run.
 */
export function planCapture(chunkTokenCounts: readonly number[], models: readonly string[]): CapturePlan {
  const tokens = chunkTokenCounts.reduce((sum, n) => sum + n, 0);
  const batches = Math.ceil(chunkTokenCounts.length / MAX_INPUTS_PER_REQUEST);

  const perModel = models.map(model => {
    const usd = getEmbeddingModelCost(model, tokens);
    return { model, tokens, batches, usd, unpriced: usd === 0 && tokens > 0 && !isKeylessLocalModel(model) };
  });

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
  /** Chunks excluded, and why, in the shipped `ChunkSkipReason` vocabulary. */
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
  return models as SupportedEmbeddingModel[];
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
