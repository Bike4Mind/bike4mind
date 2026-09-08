import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import useStartChatWithLake, { useStartChatWithLakes } from './useStartChatWithLake';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

const setCurrentSession = vi.fn();
const setCurrentSessionId = vi.fn();
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ setCurrentSession, setCurrentSessionId }),
}));

const closeManager = vi.fn();
vi.mock('@client/app/stores/useDataLakeWizardStore', () => ({
  useDataLakeWizardStore: (selector: (s: { closeManager: () => void }) => unknown) => selector({ closeManager }),
}));

const apiPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: (...args: unknown[]) => apiPost(...args) },
}));

const renderWithClient = <T,>(hook: () => T) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(hook, { wrapper });
};

beforeEach(() => {
  mockNavigate.mockClear();
  setCurrentSession.mockClear();
  setCurrentSessionId.mockClear();
  closeManager.mockClear();
  apiPost.mockReset();
});

describe('useStartChatWithLake (single lake)', () => {
  it('posts dataLakeId and opens the created session', async () => {
    apiPost.mockResolvedValue({ data: { id: 'session-1' } });
    const { result } = renderWithClient(() => useStartChatWithLake());

    let created: unknown;
    await act(async () => {
      created = await result.current('lake-1');
    });

    expect(apiPost).toHaveBeenCalledWith('/api/sessions/create', { name: 'New Notebook', dataLakeId: 'lake-1' });
    expect(created).toEqual({ id: 'session-1' });
    expect(setCurrentSession).toHaveBeenCalledWith({ id: 'session-1' });
    expect(setCurrentSessionId).toHaveBeenCalledWith('session-1');
    expect(closeManager).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/notebooks/$id', params: { id: 'session-1' }, replace: true });
  });
});

describe('useStartChatWithLakes (multi-lake subset)', () => {
  it('sends retrievalTags, forceKnowledgeRetrieval, and the given groundingMode - no dataLakeId', async () => {
    apiPost.mockResolvedValue({ data: { id: 'session-2' } });
    const { result } = renderWithClient(() => useStartChatWithLakes());

    await act(async () => {
      await result.current({ retrievalTags: ['datalake:a', 'datalake:b'], groundingMode: 'inline' });
    });

    expect(apiPost).toHaveBeenCalledWith('/api/sessions/create', {
      name: 'New Notebook',
      retrievalTags: ['datalake:a', 'datalake:b'],
      forceKnowledgeRetrieval: true,
      corpusGroundingMode: 'inline',
    });
    expect(setCurrentSession).toHaveBeenCalledWith({ id: 'session-2' });
  });

  it('sends preauthorizedLakeIds when the caller may admit some of the checked lakes', async () => {
    apiPost.mockResolvedValue({ data: { id: 'session-3' } });
    const { result } = renderWithClient(() => useStartChatWithLakes());

    await act(async () => {
      await result.current({
        retrievalTags: ['datalake:a', 'datalake:b'],
        groundingMode: 'retrieve',
        preauthorizedLakeIds: ['lake-a'],
      });
    });

    expect(apiPost).toHaveBeenCalledWith('/api/sessions/create', {
      name: 'New Notebook',
      retrievalTags: ['datalake:a', 'datalake:b'],
      forceKnowledgeRetrieval: true,
      corpusGroundingMode: 'retrieve',
      preauthorizedLakeIds: ['lake-a'],
    });
  });

  it('omits preauthorizedLakeIds entirely when the admission list is empty', async () => {
    // An empty array must not appear in the body: the route treats a present-but-empty list as a
    // request to admit nothing, and an ordinary test session's payload should be byte-identical to
    // what it was before the admission existed.
    apiPost.mockResolvedValue({ data: { id: 'session-4' } });
    const { result } = renderWithClient(() => useStartChatWithLakes());

    await act(async () => {
      await result.current({ retrievalTags: ['datalake:a'], groundingMode: 'retrieve', preauthorizedLakeIds: [] });
    });

    expect(apiPost).toHaveBeenCalledWith('/api/sessions/create', {
      name: 'New Notebook',
      retrievalTags: ['datalake:a'],
      forceKnowledgeRetrieval: true,
      corpusGroundingMode: 'retrieve',
    });
  });

  it('propagates a request failure so the caller can surface its own error UX', async () => {
    apiPost.mockRejectedValue(new Error('network down'));
    const { result } = renderWithClient(() => useStartChatWithLakes());

    await expect(
      act(async () => {
        await result.current({ retrievalTags: ['datalake:a'], groundingMode: 'retrieve' });
      })
    ).rejects.toThrow('network down');
    expect(setCurrentSession).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
