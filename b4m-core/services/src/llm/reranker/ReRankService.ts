import type { ILogger } from '@bike4mind/observability';
import type { SmallLLMAdapters, ReRankCandidate, ReRankResult, ReRankConfig } from '@bike4mind/common';
import { SmallLLMService } from '../SmallLLMService';

const DEFAULT_MAX_CANDIDATES = 30;
const DEFAULT_LLM_WEIGHT = 0.7;
const DEFAULT_MIN_RELEVANCE_SCORE = 3;

/**
 * ReRankService: Provider-agnostic LLM-based re-ranking for search results.
 *
 * Uses SmallLLMService to score candidates against a query, then combines
 * LLM relevance scores with cosine similarity for final ranking.
 *
 * Key improvements over the old reranker.ts:
 * 1. Provider-agnostic (uses ICompletionBackend, not direct OpenAI SDK)
 * 2. Configurable candidate pool size, weights, and minimum scores
 * 3. Filters out low-relevance results (removes noise)
 * 4. Graceful fallback to cosine-only on LLM failure
 *
 * Usage:
 *   const { modelId, llm } = await OperationsModelService.getOperationsModel();
 *   const reRankService = new ReRankService({ llm, modelId }, logger);
 *   const results = await reRankService.reRank(query, candidates, { maxCandidates: 40 });
 */
export class ReRankService {
  private smallLLM: SmallLLMService;
  private logger: ILogger;

  constructor(adapters: SmallLLMAdapters, logger?: ILogger) {
    this.logger = logger || { debug() {}, info() {}, warn() {}, error() {} };
    this.smallLLM = new SmallLLMService(adapters, this.logger);
  }

  /**
   * Re-rank candidates using LLM relevance scoring.
   *
   * Sends candidates to the LLM for relevance judgment, then combines
   * LLM scores with cosine similarity using configurable weights.
   * Filters out candidates below the minimum relevance threshold.
   *
   * @param query - The user's search query
   * @param candidates - Candidates to re-rank (from keyword + semantic search)
   * @param config - Optional configuration for pool size, weights, thresholds
   */
  async reRank(query: string, candidates: ReRankCandidate[], config?: ReRankConfig): Promise<ReRankResult[]> {
    const { maxCandidates = DEFAULT_MAX_CANDIDATES } = config || {};
    let llmWeight = config?.llmWeight ?? DEFAULT_LLM_WEIGHT;
    let minRelevanceScore = config?.minRelevanceScore ?? DEFAULT_MIN_RELEVANCE_SCORE;

    // Validate and clamp config values to valid ranges
    if (typeof llmWeight !== 'number' || Number.isNaN(llmWeight)) {
      this.logger.warn(`ReRankService: invalid llmWeight, using default ${DEFAULT_LLM_WEIGHT}`);
      llmWeight = DEFAULT_LLM_WEIGHT;
    } else if (llmWeight < 0 || llmWeight > 1) {
      const original = llmWeight;
      llmWeight = Math.min(1, Math.max(0, llmWeight));
      this.logger.warn(`ReRankService: llmWeight ${original} out of range [0, 1], clamped to ${llmWeight}`);
    }

    if (typeof minRelevanceScore !== 'number' || Number.isNaN(minRelevanceScore)) {
      this.logger.warn(`ReRankService: invalid minRelevanceScore, using default ${DEFAULT_MIN_RELEVANCE_SCORE}`);
      minRelevanceScore = DEFAULT_MIN_RELEVANCE_SCORE;
    } else if (minRelevanceScore < 0 || minRelevanceScore > 10) {
      const original = minRelevanceScore;
      minRelevanceScore = Math.min(10, Math.max(0, minRelevanceScore));
      this.logger.warn(
        `ReRankService: minRelevanceScore ${original} out of range [0, 10], clamped to ${minRelevanceScore}`
      );
    }

    if (!candidates.length) return [];

    // Take top candidates by cosine for LLM evaluation
    const toRank = [...candidates].sort((a, b) => b.cosineSimilarity - a.cosineSimilarity).slice(0, maxCandidates);

    try {
      const { data: scores, metrics } = await this.smallLLM.scoreBatch(
        query,
        toRank.map(c => ({ id: c.id, text: c.snippet })),
        'How well does this text snippet answer or relate to the user query? Score 0 for completely irrelevant, 10 for directly answers the query.',
        {
          taskType: 'reranking',
          temperature: 0,
          maxTokens: Math.min(toRank.length * 80, 4000),
          timeoutMs: 15000,
        }
      );

      this.logger.info(`ReRankService: scored ${scores.length} candidates in ${metrics.latencyMs}ms`);

      // Build score lookup map
      const scoreMap = new Map(scores.map(s => [s.id, s]));
      const cosineWeight = 1 - llmWeight;

      // Merge LLM scores with candidates
      const results: ReRankResult[] = toRank.map(candidate => {
        const llmResult = scoreMap.get(candidate.id);
        // Default to 0 for missing IDs - treat as low confidence, not neutral
        const relevanceScore = llmResult?.score ?? 0;
        const reason = llmResult?.reason ?? 'No LLM assessment (id missing from response)';
        const finalScore = (relevanceScore / 10) * llmWeight + candidate.cosineSimilarity * cosineWeight;

        return {
          ...candidate,
          relevanceScore,
          reason,
          finalScore,
        };
      });

      // Filter out irrelevant results and sort by finalScore
      return results.filter(r => r.relevanceScore >= minRelevanceScore).sort((a, b) => b.finalScore - a.finalScore);
    } catch (error) {
      this.logger.warn(
        'ReRankService: LLM re-ranking failed, falling back to cosine sorting:',
        error instanceof Error ? error.message : String(error)
      );
      return this.fallbackToCosineSorting(candidates);
    }
  }

  private fallbackToCosineSorting(candidates: ReRankCandidate[]): ReRankResult[] {
    return candidates
      .map(c => ({
        ...c,
        relevanceScore: -1,
        reason: 'Fallback: cosine similarity only',
        finalScore: c.cosineSimilarity,
      }))
      .sort((a, b) => b.finalScore - a.finalScore);
  }
}
