import { describe, it, expect, vi } from 'vitest';
import { ReRankService } from './ReRankService';
import type { SmallLLMAdapters, ReRankCandidate } from '@bike4mind/common';

function createMockAdapters(scores: Array<{ id: string; score: number; reason: string }>): SmallLLMAdapters {
  const responseText = JSON.stringify(scores);
  return {
    modelId: 'test-model',
    llm: {
      complete: vi.fn(async (_model, _messages, _options, callback) => {
        await callback([responseText], { inputTokens: 50, outputTokens: 30 });
      }),
    },
  };
}

function createFailingAdapters(): SmallLLMAdapters {
  return {
    modelId: 'test-model',
    llm: {
      complete: vi.fn(async () => {
        throw new Error('LLM unavailable');
      }),
    },
  };
}

const sampleCandidates: ReRankCandidate[] = [
  { id: 'art-history', snippet: 'The history of Renaissance art and painting', cosineSimilarity: 0.6 },
  { id: 'tuna-sandwich', snippet: 'How to make the best tuna sandwich', cosineSimilarity: 0.65 },
  { id: 'cave-art', snippet: 'Cave art and early human symbolic expression', cosineSimilarity: 0.55 },
  { id: 'pro-forma', snippet: 'Business pro forma financial model for 2026', cosineSimilarity: 0.62 },
];

describe('ReRankService', () => {
  describe('reRank()', () => {
    it('re-ranks candidates using LLM scores', async () => {
      const adapters = createMockAdapters([
        { id: 'art-history', score: 9, reason: 'Directly about art' },
        { id: 'tuna-sandwich', score: 1, reason: 'Not about art' },
        { id: 'cave-art', score: 8, reason: 'About early art forms' },
        { id: 'pro-forma', score: 0, reason: 'Financial document, not art' },
      ]);
      const service = new ReRankService(adapters);

      const results = await service.reRank('art', sampleCandidates);

      // Art-related results should be ranked higher
      expect(results[0].id).toBe('art-history');
      expect(results[1].id).toBe('cave-art');

      // Low-scoring results should be filtered out (score < 3)
      const ids = results.map(r => r.id);
      expect(ids).not.toContain('tuna-sandwich');
      expect(ids).not.toContain('pro-forma');
    });

    it('filters candidates below minRelevanceScore', async () => {
      const adapters = createMockAdapters([
        { id: 'art-history', score: 9, reason: 'Very relevant' },
        { id: 'tuna-sandwich', score: 2, reason: 'Not relevant' },
        { id: 'cave-art', score: 7, reason: 'Relevant' },
        { id: 'pro-forma', score: 1, reason: 'Irrelevant' },
      ]);
      const service = new ReRankService(adapters);

      const results = await service.reRank('art', sampleCandidates, { minRelevanceScore: 5 });

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('art-history');
      expect(results[1].id).toBe('cave-art');
    });

    it('respects maxCandidates limit', async () => {
      const adapters = createMockAdapters([
        { id: 'tuna-sandwich', score: 5, reason: 'Moderate' },
        { id: 'pro-forma', score: 5, reason: 'Moderate' },
      ]);
      const service = new ReRankService(adapters);

      // Only send top 2 by cosine (tuna-sandwich 0.65, pro-forma 0.62)
      await service.reRank('query', sampleCandidates, { maxCandidates: 2 });

      const callArgs = (adapters.llm.complete as ReturnType<typeof vi.fn>).mock.calls[0];
      const userMsg = callArgs[1].find((m: { role: string }) => m.role === 'user');
      // Should only mention 2 items
      expect(userMsg.content).toContain('tuna-sandwich');
      expect(userMsg.content).toContain('pro-forma');
      expect(userMsg.content).not.toContain('art-history');
      expect(userMsg.content).not.toContain('cave-art');
    });

    it('combines LLM score and cosine similarity using weights', async () => {
      const adapters = createMockAdapters([{ id: 'art-history', score: 10, reason: 'Perfect' }]);
      const service = new ReRankService(adapters);

      const results = await service.reRank('art', [sampleCandidates[0]], { llmWeight: 0.7 });

      // finalScore = (10/10) * 0.7 + 0.6 * 0.3 = 0.7 + 0.18 = 0.88
      expect(results[0].finalScore).toBeCloseTo(0.88, 2);
    });

    it('returns empty array for empty candidates', async () => {
      const adapters = createMockAdapters([]);
      const service = new ReRankService(adapters);

      const results = await service.reRank('query', []);
      expect(results).toEqual([]);
    });

    it('falls back to cosine sorting on LLM failure', async () => {
      const adapters = createFailingAdapters();
      const service = new ReRankService(adapters);

      const results = await service.reRank('art', sampleCandidates);

      // Should be sorted by cosine similarity descending
      expect(results[0].id).toBe('tuna-sandwich'); // 0.65
      expect(results[1].id).toBe('pro-forma'); // 0.62
      expect(results[2].id).toBe('art-history'); // 0.6
      expect(results[3].id).toBe('cave-art'); // 0.55

      // All should have relevanceScore -1 (fallback indicator)
      expect(results.every(r => r.relevanceScore === -1)).toBe(true);
      expect(results.every(r => r.reason === 'Fallback: cosine similarity only')).toBe(true);
    });

    it('filters out candidates not scored by LLM (treated as low confidence)', async () => {
      // LLM only returns scores for 2 of 4 candidates
      const adapters = createMockAdapters([
        { id: 'art-history', score: 9, reason: 'Relevant' },
        { id: 'cave-art', score: 8, reason: 'Related' },
      ]);
      const service = new ReRankService(adapters);

      const results = await service.reRank('art', sampleCandidates);

      // tuna-sandwich and pro-forma should be filtered out (score 0 < minRelevanceScore 3)
      const tunaResult = results.find(r => r.id === 'tuna-sandwich');
      const proFormaResult = results.find(r => r.id === 'pro-forma');
      expect(tunaResult).toBeUndefined();
      expect(proFormaResult).toBeUndefined();

      // Only the scored candidates should remain
      expect(results.length).toBe(2);
      expect(results.map(r => r.id)).toEqual(['art-history', 'cave-art']);
    });

    it('includes unscored candidates when minRelevanceScore is 0', async () => {
      // LLM only returns scores for 2 of 4 candidates
      const adapters = createMockAdapters([
        { id: 'art-history', score: 9, reason: 'Relevant' },
        { id: 'cave-art', score: 8, reason: 'Related' },
      ]);
      const service = new ReRankService(adapters);

      const results = await service.reRank('art', sampleCandidates, { minRelevanceScore: 0 });

      // All 4 candidates should be present
      expect(results.length).toBe(4);

      // Unscored candidates get score 0 with explanatory reason
      const tunaResult = results.find(r => r.id === 'tuna-sandwich');
      expect(tunaResult?.relevanceScore).toBe(0);
      expect(tunaResult?.reason).toBe('No LLM assessment (id missing from response)');
    });

    it('includes metrics in response timing', async () => {
      const adapters = createMockAdapters([{ id: 'art-history', score: 8, reason: 'Good' }]);
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const service = new ReRankService(adapters, logger);

      await service.reRank('art', [sampleCandidates[0]]);

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('scored 1 candidates in'));
    });
  });
});
