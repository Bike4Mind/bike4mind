import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useGetFabFilesBySessionId, useGetFabFilesByQuestId } from './fabFiles';

// Mock the axios-backed api context - we only care that the GET is (or isn't) fired.
const apiGet = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
  },
}));

const makeWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = 'TestQueryClientWrapper';
  return Wrapper;
};

const renderSession = (sessionId: string, enabled = true) =>
  renderHook(() => useGetFabFilesBySessionId(sessionId, { enabled }), { wrapper: makeWrapper() });

const renderQuest = (questId: string, enabled = true) =>
  renderHook(() => useGetFabFilesByQuestId(questId, { enabled }), { wrapper: makeWrapper() });

describe('useGetFabFilesBySessionId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Regression: when the chat input is hydrated with an optimistic session id
  // (pre-navigation, before the real id is minted) the hook used to fire
  // GET /api/sessions/optimistic-session-*/files which the server rejects
  // with 400 "Invalid session ID format".
  it('does not fetch while sessionId is an optimistic placeholder', () => {
    renderSession('optimistic-session-abc-123');
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('fetches for a real (non-optimistic) sessionId', async () => {
    apiGet.mockResolvedValue({ data: [] });
    renderSession('507f1f77bcf86cd799439011');

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith('/api/sessions/507f1f77bcf86cd799439011/files');
    });
  });

  it('respects the caller-supplied enabled=false', () => {
    renderSession('507f1f77bcf86cd799439011', false);
    expect(apiGet).not.toHaveBeenCalled();
  });
});

describe('useGetFabFilesByQuestId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Same class of bug on the quest-id sibling: quest ids can be
  // `optimistic-quest-*` placeholders before the server response lands. The
  // guard used to live at the MessageContent.tsx caller; it now lives in the
  // hook so new callers can't re-introduce the 400.
  it('does not fetch while questId is an optimistic placeholder', () => {
    renderQuest('optimistic-quest-abc-123');
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('fetches for a real (non-optimistic) questId', async () => {
    apiGet.mockResolvedValue({ data: [] });
    renderQuest('507f1f77bcf86cd799439012');

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith('/api/quests/507f1f77bcf86cd799439012/files');
    });
  });

  it('respects the caller-supplied enabled=false', () => {
    renderQuest('507f1f77bcf86cd799439012', false);
    expect(apiGet).not.toHaveBeenCalled();
  });
});
