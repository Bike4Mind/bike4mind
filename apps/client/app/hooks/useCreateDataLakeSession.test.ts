import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import useCreateDataLakeSession from './useCreateDataLakeSession';
import { usePendingLakeScope } from './usePendingLakeScope';

const mockNavigate = vi.fn();
let mockPathname = '/new';
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: mockPathname }),
  useSearch: () => ({}),
}));

const setCurrentSession = vi.fn();
const setCurrentSessionId = vi.fn();
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ setCurrentSession, setCurrentSessionId }),
}));

const apiPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: (...args: unknown[]) => apiPost(...args) },
}));

const renderWithClient = <T>(hook: () => T) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(hook, { wrapper });
};

beforeEach(() => {
  mockPathname = '/new';
  mockNavigate.mockClear();
  setCurrentSession.mockClear();
  setCurrentSessionId.mockClear();
  apiPost.mockReset();
  usePendingLakeScope.getState().setLakeTags([]);
});

describe('useCreateDataLakeSession', () => {
  it('carries a pending lake scope from /new into the create body, then clears it', async () => {
    apiPost.mockResolvedValue({ data: { id: 'session-1' } });
    usePendingLakeScope.getState().setLakeTags(['datalake:research', 'datalake:legal']);
    const { result } = renderWithClient(() => useCreateDataLakeSession());

    await act(async () => {
      await result.current();
    });

    expect(apiPost).toHaveBeenCalledWith('/api/sessions/create', {
      name: 'New Notebook',
      forceKnowledgeRetrieval: true,
      retrievalTags: ['datalake:research', 'datalake:legal'],
      lakeScopeExplicit: true,
    });
    // Consumed - a scope picked for this /new must not silently apply to the next one.
    expect(usePendingLakeScope.getState().lakeTags).toEqual([]);
  });

  it('sends neither retrievalTags nor lakeScopeExplicit when no scope was picked', async () => {
    apiPost.mockResolvedValue({ data: { id: 'session-2' } });
    const { result } = renderWithClient(() => useCreateDataLakeSession());

    await act(async () => {
      await result.current();
    });

    expect(apiPost).toHaveBeenCalledWith('/api/sessions/create', {
      name: 'New Notebook',
      forceKnowledgeRetrieval: true,
    });
  });

  it('includes knowledgeIds the caller passed, alongside a picked scope', async () => {
    apiPost.mockResolvedValue({ data: { id: 'session-3' } });
    usePendingLakeScope.getState().setLakeTags(['datalake:research']);
    const { result } = renderWithClient(() => useCreateDataLakeSession());

    await act(async () => {
      await result.current({ knowledgeIds: ['file-1'] });
    });

    expect(apiPost).toHaveBeenCalledWith('/api/sessions/create', {
      name: 'New Notebook',
      forceKnowledgeRetrieval: true,
      retrievalTags: ['datalake:research'],
      lakeScopeExplicit: true,
      knowledgeIds: ['file-1'],
    });
  });

  it('adopts the created session and navigates off /new to the new notebook', async () => {
    apiPost.mockResolvedValue({ data: { id: 'session-4' } });
    const { result } = renderWithClient(() => useCreateDataLakeSession());

    await act(async () => {
      await result.current();
    });

    expect(setCurrentSession).toHaveBeenCalledWith({ id: 'session-4' });
    expect(setCurrentSessionId).toHaveBeenCalledWith('session-4');
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/notebooks/$id', params: { id: 'session-4' }, replace: true })
    );
  });

  it('does not navigate when called off /new (the send-path seam already has the URL)', async () => {
    mockPathname = '/notebooks/existing';
    apiPost.mockResolvedValue({ data: { id: 'session-5' } });
    const { result } = renderWithClient(() => useCreateDataLakeSession());

    await act(async () => {
      await result.current();
    });

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
