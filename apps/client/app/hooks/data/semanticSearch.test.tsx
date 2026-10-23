import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { AxiosError, AxiosHeaders } from 'axios';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useSemanticSearch } from './semanticSearch';
import { useAdvancedSearch } from '@client/app/hooks/useAdvancedSearch';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn() } }));

const post = api.post as unknown as Mock;

const renderSemanticSearch = () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useSemanticSearch(), { wrapper });
};

describe('useSemanticSearch onSuccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAdvancedSearch.setState({
      semanticResults: null,
      semanticDebugInfo: null,
      isSemanticSearching: false,
      semanticSearchError: null,
    });
  });

  // The API's zero-session early return is a 200 with no `debug`/`scores` block. onSuccess used to
  // dereference `data.debug.query`, throwing "Cannot read properties of undefined (reading 'query')";
  // query-core routes an onSuccess throw to onError, so the mutation REJECTED and left an error the
  // drawer rendered as a raw TypeError. The fix treats the missing block as a valid empty result, so
  // the mutation resolves cleanly - the resolves() and error/results assertions below fail on the old code.
  it('handles the zero-session 200 (no debug/scores) without throwing', async () => {
    post.mockResolvedValue({ data: { sessionIds: [], count: 0 } });
    const { result } = renderSemanticSearch();

    await expect(result.current.mutateAsync({ query: 'anything' })).resolves.toBeDefined();

    const state = useAdvancedSearch.getState();
    expect(state.semanticResults).toEqual([]);
    expect(state.semanticDebugInfo).toBeNull();
    expect(state.isSemanticSearching).toBe(false);
    expect(state.semanticSearchError).toBeNull();
  });

  it('populates debug info and scores on a full response', async () => {
    post.mockResolvedValue({
      data: {
        sessionIds: ['s1'],
        count: 1,
        scores: [
          {
            sessionId: 's1',
            sessionName: 'Session 1',
            maxSimilarity: 0.9,
            matchingMessages: 2,
            bestMatch: { similarity: 0.9, snippet: 'hello' },
          },
        ],
        debug: {
          query: 'greeting',
          minSimilarity: 0.5,
          hybridMode: true,
          keywords: ['greeting'],
          keywordMatchCount: 1,
          messagesWithEmbedding: 3,
          messagesGenerated: 3,
        },
      },
    });
    const { result } = renderSemanticSearch();

    await result.current.mutateAsync({ query: 'greeting' });

    const state = useAdvancedSearch.getState();
    expect(state.semanticResults).toEqual(['s1']);
    expect(state.semanticDebugInfo?.query).toBe('greeting');
    expect(state.semanticDebugInfo?.scores).toHaveLength(1);
    expect(state.isSemanticSearching).toBe(false);
  });
});

describe('useSemanticSearch onError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAdvancedSearch.setState({ semanticSearchError: null });
  });

  const axiosError = (status: number, data: unknown) =>
    new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', undefined, undefined, {
      status,
      statusText: '',
      data,
      headers: {},
      config: { headers: new AxiosHeaders() },
    });

  it("surfaces the server's insufficient-credits message instead of the generic axios text", async () => {
    const message = 'You do not have enough credits for semantic search.';
    post.mockRejectedValue(axiosError(422, { errorCode: 'insufficient_credits', error: message }));
    const { result } = renderSemanticSearch();

    await expect(result.current.mutateAsync({ query: 'anything' })).rejects.toBeDefined();

    expect(useAdvancedSearch.getState().semanticSearchError).toBe(message);
  });

  it("surfaces the server's message when AI features are disabled on the account (403)", async () => {
    const message = 'AI features are disabled on your account by an administrator. Please contact support.';
    post.mockRejectedValue(axiosError(403, { error: message }));
    const { result } = renderSemanticSearch();

    await expect(result.current.mutateAsync({ query: 'anything' })).rejects.toBeDefined();

    expect(useAdvancedSearch.getState().semanticSearchError).toBe(message);
  });

  it('keeps the axios message for other errors', async () => {
    post.mockRejectedValue(axiosError(500, { error: 'boom' }));
    const { result } = renderSemanticSearch();

    await expect(result.current.mutateAsync({ query: 'anything' })).rejects.toBeDefined();

    expect(useAdvancedSearch.getState().semanticSearchError).toBe('Request failed with status code 500');
  });
});
