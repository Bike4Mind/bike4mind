import { isSupportedEmbeddingModel, type SupportedEmbeddingModel } from '@bike4mind/common';
import { EmbeddingFactory, getProviderFromModel, resolveEmbeddingConfig } from '@bike4mind/utils';
import type { Logger } from '@bike4mind/observability';
import { partitionByVectorSearchReadiness, type VectorSearchReadinessFile } from './vectorSearchEligibility';
import type { EmbeddingLabeledFile } from './embeddingMismatch';
import type { SemanticChunkResult, SemanticDataLakeSearchParams } from './semanticDataLakeSearch';
import type { AnnVectorSearchResult } from './annVectorSearch';

/**
 * Planning for the multi-model Atlas/OpenSearch ANN cutover: which of a mixed-model lake's
 * non-query-model files get their OWN ANN query (re-embedding the search text under their model
 * and querying that model's own index), versus which stay excluded exactly as they were before
 * this cutover existed.
 *
 * Cost policy, not readiness: `VECTOR_SEARCH_READY_LAG_MS` (vectorSearchEligibility.ts) is a pure,
 * dependency-free per-file time gate; this cap bounds embedding-provider fan-out per search, which
 * is a different concern living with the planner that enforces it.
 */

/**
 * How many distinct alternate models get their own extra query embed + ANN query per search.
 * Latency/rate-limit exposure is the binding cost, not spend (a query is tens of tokens). A
 * realistic re-embedding history is 2-3 models deep; this covers that while keeping a lake with a
 * long, pathological label history from fanning out unboundedly. Not an admin-settings knob - no
 * operator has asked to tune this; promote it if one does.
 */
export const MAX_ALTERNATE_ANN_MODELS = 3;

export type AlternateAnnSkipReason =
  | 'unsupportedModel' // not in the embedding registry - never hand to EmbeddingFactory
  | 'noQueryableIndex' // registry-known, but no queryable ANN index right now
  | 'missingCredential' // caller's apiKeyTable cannot embed under this model
  | 'notAnnReady' // stamp absent or inside the mongot/indexing lag - no scan fallback by design
  | 'notVectorized' // vectorizedChunkCount === 0: nothing to find
  | 'overModelCap'; // beyond MAX_ALTERNATE_ANN_MODELS

export interface AlternateAnnCandidate<T> {
  model: string;
  /** The only files this model's query will cover - files not yet ANN-ready are excluded, never scanned. */
  annReady: T[];
}

export interface AlternateAnnPlan<T> {
  /** <= cap, ordered by selection (ANN-ready coverage desc, then model name asc). */
  selected: AlternateAnnCandidate<T>[];
  /** Logging only - every bucket that did not make the cut, and why. */
  skipped: Array<{ model: string; files: T[]; reason: AlternateAnnSkipReason }>;
}

/**
 * Decide which alternate-model buckets get their own ANN query this search.
 *
 * Gate order is deliberate: cheapest and most decisive first, so nothing reaches an external call
 * it cannot use.
 *  1. Zero alternates: no-op, no awaits - a single-model lake costs nothing extra.
 *  2. Registry membership: an unrecognized label would otherwise reach EmbeddingFactory and throw.
 *  3. Vectorized-at-all: a never-vectorized file must not outrank a real one for a cap slot.
 *  4. ANN readiness (per file): not-yet-ready alternate-model files are excluded, NEVER scanned -
 *     this is the ticket's explicit scope boundary, not an oversight.
 *  5. Credential: cheap and synchronous, checked before the index probe.
 *  6. Index queryable (concurrent): a metadata read, not an embed - probing every survivor (not
 *     just the top `cap`) keeps the cap meaning "extra embed+query calls" only.
 *  7. Rank by ANN-ready coverage desc, tiebreak by model name asc for reproducibility, take `cap`.
 */
export async function planAlternateAnnModels<T extends EmbeddingLabeledFile & VectorSearchReadinessFile>(args: {
  alternates: Array<{ model: string; files: T[] }>;
  now: Date;
  apiKeyTable: SemanticDataLakeSearchParams['apiKeyTable'];
  isModelQueryable: (model: string) => Promise<boolean>;
  cap?: number;
  logger?: Logger;
}): Promise<AlternateAnnPlan<T>> {
  const { alternates, now, apiKeyTable, isModelQueryable, logger } = args;
  const cap = args.cap ?? MAX_ALTERNATE_ANN_MODELS;
  const skipped: AlternateAnnPlan<T>['skipped'] = [];

  if (alternates.length === 0) return { selected: [], skipped: [] };

  const survivors: Array<{ model: string; annReady: T[] }> = [];
  for (const bucket of alternates) {
    if (!isSupportedEmbeddingModel(bucket.model)) {
      skipped.push({ model: bucket.model, files: bucket.files, reason: 'unsupportedModel' });
      continue;
    }
    const vectorized = bucket.files.filter(f => (f.vectorizedChunkCount ?? 0) > 0);
    if (vectorized.length === 0) {
      skipped.push({ model: bucket.model, files: bucket.files, reason: 'notVectorized' });
      continue;
    }
    const { annReady, scanOnly } = partitionByVectorSearchReadiness(vectorized, now);
    if (scanOnly.length > 0) skipped.push({ model: bucket.model, files: scanOnly, reason: 'notAnnReady' });
    if (annReady.length === 0) continue;

    if (resolveEmbeddingConfig(getProviderFromModel(bucket.model), apiKeyTable).missing) {
      skipped.push({ model: bucket.model, files: annReady, reason: 'missingCredential' });
      continue;
    }
    survivors.push({ model: bucket.model, annReady });
  }

  const queryableFlags = await Promise.all(
    survivors.map(async s => {
      try {
        return await isModelQueryable(s.model);
      } catch (error) {
        logger?.warn?.('[semanticSearch] alternate-model index status check failed, treating as not queryable', {
          model: s.model,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    })
  );
  const queryable: Array<{ model: string; annReady: T[] }> = [];
  survivors.forEach((s, i) => {
    if (queryableFlags[i]) queryable.push(s);
    else skipped.push({ model: s.model, files: s.annReady, reason: 'noQueryableIndex' });
  });

  queryable.sort(
    (a, b) => b.annReady.length - a.annReady.length || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0)
  );
  const selected = queryable.slice(0, cap);
  for (const over of queryable.slice(cap)) {
    skipped.push({ model: over.model, files: over.annReady, reason: 'overModelCap' });
  }

  return { selected, skipped };
}

/**
 * Embed `query` under `model`, returning null (never throwing) on any failure - missing
 * credential, an unbuildable service, a provider outage, or an empty vector. The alternate-model
 * path must degrade to "those files stay excluded", never a 500 - unlike the PRIMARY model's
 * embed (semanticDataLakeSearch.ts), which deliberately still throws on a missing credential: a
 * misconfigured deployment failing loud on the model it was actually asked for is the behavior
 * embeddingMismatch.ts exists to protect, and that must not change here.
 */
export async function tryEmbedQueryForModel(args: {
  query: string;
  model: string;
  apiKeyTable: SemanticDataLakeSearchParams['apiKeyTable'];
  logger?: Logger;
}): Promise<number[] | null> {
  const { query, model, apiKeyTable, logger } = args;
  try {
    // planAlternateAnnModels' registry-membership gate already guarantees `model` is supported
    // before it is ever selected, so this cast reflects an already-checked invariant.
    const supportedModel = model as SupportedEmbeddingModel;
    const { config, missing } = resolveEmbeddingConfig(getProviderFromModel(supportedModel), apiKeyTable);
    if (missing) return null;
    const vector = await new EmbeddingFactory(config).createEmbeddingService(supportedModel).generateEmbedding(query);
    return vector.length > 0 ? vector : null;
  } catch (error) {
    logger?.warn?.('[semanticSearch] alternate-model query embedding failed', {
      model,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export interface AlternateAnnOutcome {
  model: string;
  results: SemanticChunkResult[];
  hitsReturned: number;
  hitsSkippedUnknownFile: number;
  /** Files this model's ANN query actually returned a raw hit for - NOT to be reported as excluded. */
  filesWithHits: Set<string>;
  /** ANN-ready but zero raw hits: still excluded, never scanned (this model has no scan fallback). */
  filesMissed: string[];
  /** The query embed under this model succeeded, i.e. a billable provider call was made. */
  embedded: boolean;
  /** Embed failed, or embed succeeded but the ANN query itself failed - either way, no usable results from this model. */
  failed: boolean;
}

const EMPTY_OUTCOME = (model: string, embedded: boolean): AlternateAnnOutcome => ({
  model,
  results: [],
  hitsReturned: 0,
  hitsSkippedUnknownFile: 0,
  filesWithHits: new Set(),
  filesMissed: [],
  embedded,
  failed: true,
});

/**
 * Run one alternate model's ANN query: embed the query under it, then query that model's own ANN
 * index via the injected `runAnn` (the caller's Atlas/OpenSearch seam - this module never learns
 * which backend is active). Never rejects, so callers can `Promise.all` every selected candidate
 * without one failure taking down the others.
 *
 * Deliberately does NOT rebucket a missed/failed candidate onto the brute-force scan - the scan
 * path stays single-model by design; an alternate model's unreachable files simply stay excluded,
 * exactly as they were before this cutover.
 */
export async function runAlternateModelAnn(args: {
  query: string;
  candidate: AlternateAnnCandidate<{ id: string }>;
  apiKeyTable: SemanticDataLakeSearchParams['apiKeyTable'];
  // Already bakes in fileById/topK/minScore - see the closure built in rankChunksForFiles.
  runAnn: (a: { fileIds: string[]; queryVector: number[]; model: string }) => Promise<AnnVectorSearchResult>;
  logger?: Logger;
}): Promise<AlternateAnnOutcome> {
  const { query, candidate, apiKeyTable, runAnn, logger } = args;

  const queryVector = await tryEmbedQueryForModel({ query, model: candidate.model, apiKeyTable, logger });
  if (!queryVector) return EMPTY_OUTCOME(candidate.model, false);

  try {
    const fileIds = candidate.annReady.map(f => f.id);
    const result = await runAnn({ fileIds, queryVector, model: candidate.model });
    // Same "zero raw hits" signal the primary model uses (semanticDataLakeSearch.ts's
    // missedFiles rebucket): a queryable index does not guarantee this model's chunks are
    // actually in it yet (indexing lag, or a mid-file re-embed under the wrong model).
    const filesMissed = candidate.annReady.map(f => f.id).filter(id => !result.filesWithHits.has(id));
    return {
      model: candidate.model,
      results: result.results,
      hitsReturned: result.hitsReturned,
      hitsSkippedUnknownFile: result.hitsSkippedUnknownFile,
      filesWithHits: result.filesWithHits,
      filesMissed,
      embedded: true,
      failed: false,
    };
  } catch (error) {
    logger?.warn?.('[semanticSearch] alternate-model ANN query failed', {
      model: candidate.model,
      fileCount: candidate.annReady.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return EMPTY_OUTCOME(candidate.model, true);
  }
}
