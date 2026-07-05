/**
 * Hybrid semantic search across notebook message content:
 * 1. Filter messages containing the search terms (keyword match)
 * 2. Rank survivors by cosine similarity using embeddings
 */

import { useMutation } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useAdvancedSearch, SemanticSearchDebugInfo } from '@client/app/hooks/useAdvancedSearch';
import { useShallow } from 'zustand/react/shallow';

interface SemanticSearchRequest {
  query: string;
  minSimilarity?: number;
  topK?: number;
  hybridMode?: boolean; // Default: true - require keyword match before semantic ranking
  useReRanking?: boolean; // Default: false - LLM re-ranking for quality verification
}

interface SessionScore {
  sessionId: string;
  sessionName?: string;
  maxSimilarity: number;
  matchingMessages: number;
  bestMatch?: {
    similarity: number;
    snippet: string;
  };
}

interface SemanticSearchResponse {
  sessionIds: string[];
  count: number;
  scores: SessionScore[];
  debug: {
    query: string;
    correctedQuery?: string;
    queryExpansionTimeMs?: number;
    minSimilarity: number;
    hybridMode: boolean;
    keywords: string[];
    keywordMatchCount: number | null;
    messagesWithEmbedding: number;
    messagesGenerated: number;
    reRankingUsed?: boolean;
    reRankingTimeMs?: number;
    candidatesReRanked?: number;
    candidatesFiltered?: number;
  };
}

/**
 * Semantic search across notebook messages.
 */
export const useSemanticSearch = () => {
  const setSemanticResults = useAdvancedSearch(state => state.setSemanticResults);
  const setSemanticDebugInfo = useAdvancedSearch(state => state.setSemanticDebugInfo);
  const setIsSemanticSearching = useAdvancedSearch(state => state.setIsSemanticSearching);
  const setSemanticSearchError = useAdvancedSearch(state => state.setSemanticSearchError);

  return useMutation({
    mutationFn: async (request: SemanticSearchRequest): Promise<SemanticSearchResponse> => {
      const response = await api.post<SemanticSearchResponse>('/api/sessions/semantic-search', request);
      return response.data;
    },
    onMutate: () => {
      setIsSemanticSearching(true);
      setSemanticSearchError(null);
      setSemanticDebugInfo(null);
    },
    onSuccess: data => {
      setSemanticResults(data.sessionIds);

      const debugInfo: SemanticSearchDebugInfo = {
        query: data.debug.query,
        correctedQuery: data.debug.correctedQuery,
        queryExpansionTimeMs: data.debug.queryExpansionTimeMs,
        minSimilarity: data.debug.minSimilarity,
        hybridMode: data.debug.hybridMode,
        keywords: data.debug.keywords,
        keywordMatchCount: data.debug.keywordMatchCount,
        messagesWithEmbedding: data.debug.messagesWithEmbedding,
        messagesGenerated: data.debug.messagesGenerated,
        reRankingUsed: data.debug.reRankingUsed,
        reRankingTimeMs: data.debug.reRankingTimeMs,
        candidatesReRanked: data.debug.candidatesReRanked,
        candidatesFiltered: data.debug.candidatesFiltered,
        scores: data.scores.map(score => ({
          sessionId: score.sessionId,
          sessionName: score.sessionName,
          maxSimilarity: score.maxSimilarity,
          matchingMessages: score.matchingMessages,
          bestMatch: score.bestMatch,
        })),
      };
      setSemanticDebugInfo(debugInfo);
      setIsSemanticSearching(false);
    },
    onError: error => {
      const errorMessage = error instanceof Error ? error.message : 'Semantic search failed';
      setSemanticSearchError(errorMessage);
      setIsSemanticSearching(false);
      setSemanticResults(null);
      setSemanticDebugInfo(null);
    },
  });
};

/**
 * Hook that combines semantic search mutation with Zustand state management
 * Provides a simpler API for components
 */
export const useSemanticSearchWithState = () => {
  const mutation = useSemanticSearch();
  const semanticState = useAdvancedSearch(
    useShallow(state => ({
      query: state.semanticQuery,
      results: state.semanticResults,
      isSearching: state.isSemanticSearching,
      error: state.semanticSearchError,
      setQuery: state.setSemanticQuery,
      clear: state.clearSemanticSearch,
    }))
  );

  const performSearch = (query?: string) => {
    const searchQuery = query || semanticState.query;
    if (searchQuery.trim()) {
      mutation.mutate({ query: searchQuery });
    }
  };

  return {
    ...semanticState,
    performSearch,
    isPending: mutation.isPending,
  };
};
