import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const replaceQueryData = vi.fn();
const updateSingleQueryDataFast = vi.fn();
vi.mock('../../utils/react-query', () => ({
  replaceQueryData: (...args: unknown[]) => replaceQueryData(...args),
  updateSingleQueryDataFast: (...args: unknown[]) => updateSingleQueryDataFast(...args),
}));

import { useStreamingQueryUpdates } from '../useStreamingQueryUpdates';

function renderUpdates(rapidReply?: unknown) {
  const chatCompletionRef = { current: { rapidReply } };
  const setChatCompletion = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useStreamingQueryUpdates({ chatCompletionRef, setChatCompletion }), { wrapper });
  return { result, setChatCompletion, queryClient };
}

// Replay the updater function React would receive against a prev state so we
// can inspect the quest the hook intends to commit.
function appliedQuest(setChatCompletion: ReturnType<typeof vi.fn>, callIndex: number, prevQuestId: string) {
  const updater = setChatCompletion.mock.calls[callIndex][0] as (prev: any) => any;
  return updater({ quest: { id: prevQuestId } }).quest;
}

describe('useStreamingQueryUpdates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never regresses reply text when a later chunk is shorter (no rapid reply)', () => {
    const { result, setChatCompletion } = renderUpdates(undefined);

    act(() => result.current.updateStreamingQuest({ id: 'q1', sessionId: 's1', replies: ['hello'] }, false));
    act(() => result.current.updateStreamingQuest({ id: 'q1', sessionId: 's1', replies: ['he'] }, false));

    // Second commit should keep the longer previous replies, not the shorter chunk.
    expect(appliedQuest(setChatCompletion, 1, 'q1').replies).toEqual(['hello']);
  });

  it('allows a shorter reply through while a rapid reply is active', () => {
    const { result, setChatCompletion } = renderUpdates({ status: 'streaming' });

    act(() => result.current.updateStreamingQuest({ id: 'q1', sessionId: 's1', replies: ['hello'] }, false));
    act(() => result.current.updateStreamingQuest({ id: 'q1', sessionId: 's1', replies: ['he'] }, false));

    expect(appliedQuest(setChatCompletion, 1, 'q1').replies).toEqual(['he']);
  });

  it('replaces the optimistic quest only on the first chunk', () => {
    const { result } = renderUpdates(undefined);

    act(() => result.current.updateStreamingQuest({ id: 'q1', sessionId: 's1', replies: ['a'] }, false));
    act(() => result.current.updateStreamingQuest({ id: 'q1', sessionId: 's1', replies: ['ab'] }, false));

    expect(replaceQueryData).toHaveBeenCalledTimes(1);
    const [, cacheKey, replaceId] = replaceQueryData.mock.calls[0];
    expect(cacheKey).toEqual(['quests', 'session', 's1']);
    expect(replaceId).toBe('optimistic-quest-s1');
  });

  it('writes the session + individual quest cache only on completion', () => {
    const { result, queryClient } = renderUpdates(undefined);
    const setQueryData = vi.spyOn(queryClient, 'setQueryData');

    act(() => result.current.updateStreamingQuest({ id: 'q1', sessionId: 's1', replies: ['partial'] }, false));
    expect(updateSingleQueryDataFast).not.toHaveBeenCalled();

    act(() => result.current.updateStreamingQuest({ id: 'q1', sessionId: 's1', replies: ['final'] }, true));
    expect(updateSingleQueryDataFast).toHaveBeenCalledTimes(1);
    expect(setQueryData).toHaveBeenCalledWith(['quests', 'individual', 's1', 'q1'], expect.anything());
  });

  it('sets completed=true on the committed state when the chunk is final', () => {
    const { result, setChatCompletion } = renderUpdates(undefined);

    act(() => result.current.updateStreamingQuest({ id: 'q1', sessionId: 's1', replies: ['done'] }, true));

    const updater = setChatCompletion.mock.calls[0][0] as (prev: any) => any;
    expect(updater({ quest: undefined }).completed).toBe(true);
  });

  it('returns referentially stable callbacks across re-renders', () => {
    const chatCompletionRef = { current: { rapidReply: undefined } };
    const setChatCompletion = vi.fn();
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(() => useStreamingQueryUpdates({ chatCompletionRef, setChatCompletion }), {
      wrapper,
    });
    const first = result.current.updateStreamingQuest;
    rerender();
    expect(result.current.updateStreamingQuest).toBe(first);
  });
});
