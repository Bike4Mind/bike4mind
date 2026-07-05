import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { IChatHistoryItem } from '@bike4mind/common';
import { useStreamingMessageMerge } from '../useStreamingMessageMerge';
import type { IChatCompletion } from '@client/app/hooks/useSubscribeChatCompletion';

const invalidateQueries = vi.fn();
const resetStreaming = vi.fn();
const checkQuestTimeout = vi.fn();
const updateAllQueryData = vi.fn();

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock('@client/app/hooks/useStreamingState', () => ({
  useStreamingState: (selector: (s: { resetStreaming: typeof resetStreaming }) => unknown) =>
    selector({ resetStreaming }),
}));

vi.mock('@client/app/utils/sessionsAPICalls', () => ({
  checkQuestTimeout: (...args: unknown[]) => checkQuestTimeout(...args),
}));

vi.mock('@client/app/utils/react-query', () => ({
  updateAllQueryData: (...args: unknown[]) => updateAllQueryData(...args),
}));

const SESSION_ID = 'session-1';

// Minimal quest builder - only the fields the merge logic reads.
function makeQuest(overrides: Partial<IChatHistoryItem> = {}): IChatHistoryItem {
  return {
    id: 'q1',
    sessionId: SESSION_ID,
    prompt: 'hello',
    replies: ['answer'],
    status: 'done',
    type: 'message',
    timestamp: Date.now(),
    ...overrides,
  } as unknown as IChatHistoryItem;
}

function makeChatCompletion(overrides: Partial<IChatCompletion> = {}): IChatCompletion {
  return { completed: false, stopped: false, ...overrides } as IChatCompletion;
}

// chatCompletion.quest is a structurally-loose streamed shape; build it via cast.
function makeStreamQuest(overrides: Record<string, unknown> = {}): IChatCompletion['quest'] {
  return {
    id: 'q1',
    sessionId: SESSION_ID,
    prompt: 'hello',
    replies: ['streamed token'],
    status: 'running',
    ...overrides,
  } as unknown as IChatCompletion['quest'];
}

const setChatCompletion = vi.fn();

function baseParams(over: Partial<Parameters<typeof useStreamingMessageMerge>[0]> = {}) {
  return {
    sessionId: SESSION_ID,
    flattenQuests: [] as IChatHistoryItem[],
    chatCompletion: makeChatCompletion(),
    setChatCompletion,
    ...over,
  };
}

describe('useStreamingMessageMerge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns no streaming data when idle (no quest, nothing running)', () => {
    const { result } = renderHook(() => useStreamingMessageMerge(baseParams({ flattenQuests: [makeQuest()] })));

    expect(result.current.streamingMessageData).toBeNull();
    expect(result.current.activeStreamingQuestId).toBeNull();
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.showOptimisticSpinner).toBe(false);
  });

  it('merges streaming replies/status over the cached quest (Case 1)', () => {
    const cached = makeQuest({ id: 'q1', status: 'running', replies: [] });
    const chatCompletion = makeChatCompletion({
      quest: makeStreamQuest({ id: 'q1', replies: ['partial reply'], status: 'running' }),
    });

    const { result } = renderHook(() =>
      useStreamingMessageMerge(baseParams({ flattenQuests: [cached], chatCompletion }))
    );

    expect(result.current.streamingMessageData?.id).toBe('q1');
    expect(result.current.streamingMessageData?.replies).toEqual(['partial reply']);
    expect(result.current.activeStreamingQuestId).toBe('q1');
    expect(result.current.isStreaming).toBe(true);
  });

  it('shallow-merges streaming promptMeta over the base quest', () => {
    const cached = makeQuest({
      id: 'q1',
      status: 'running',
      replies: [],
      // base carries fields the stream chunk does not
      promptMeta: { context: 'base-context', model: 'gpt' } as IChatHistoryItem['promptMeta'],
    });
    const chatCompletion = makeChatCompletion({
      quest: makeStreamQuest({ id: 'q1', promptMeta: { citables: ['c1'] } }),
    });

    const { result } = renderHook(() =>
      useStreamingMessageMerge(baseParams({ flattenQuests: [cached], chatCompletion }))
    );

    expect(result.current.streamingMessageData?.promptMeta).toEqual({
      context: 'base-context',
      model: 'gpt',
      citables: ['c1'],
    });
  });

  it('does not bleed a quest from a different session', () => {
    const chatCompletion = makeChatCompletion({
      quest: makeStreamQuest({ id: 'qX', sessionId: 'other-session' }),
    });

    const { result } = renderHook(() => useStreamingMessageMerge(baseParams({ flattenQuests: [], chatCompletion })));

    expect(result.current.streamingMessageData).toBeNull();
  });

  it('hands off to ChatHistory once a completed quest is present as done (fast-completion guard)', () => {
    const done = makeQuest({ id: 'q1', status: 'done', replies: ['final'] });
    const chatCompletion = makeChatCompletion({
      completed: true,
      quest: makeStreamQuest({ id: 'q1', status: 'done', replies: ['final'] }),
    });

    const { result } = renderHook(() =>
      useStreamingMessageMerge(baseParams({ flattenQuests: [done], chatCompletion }))
    );

    expect(result.current.streamingMessageData).toBeNull();
  });

  it('falls back to chatCompletion.quest when React Query has not loaded it yet', () => {
    const chatCompletion = makeChatCompletion({
      quest: makeStreamQuest({ id: 'q-fresh', replies: ['early token'], status: 'running' }),
    });

    const { result } = renderHook(() => useStreamingMessageMerge(baseParams({ flattenQuests: [], chatCompletion })));

    expect(result.current.streamingMessageData?.id).toBe('q-fresh');
    expect(result.current.streamingMessageData?.replies).toEqual(['early token']);
    expect(result.current.isStreaming).toBe(true);
  });

  it('renders the latest running quest when streaming has not started (Case 2)', () => {
    const running = makeQuest({ id: 'q-run', status: 'running', replies: [] });

    const { result } = renderHook(() =>
      useStreamingMessageMerge(baseParams({ flattenQuests: [running, makeQuest({ id: 'q-old' })] }))
    );

    expect(result.current.streamingMessageData?.id).toBe('q-run');
    expect(result.current.isStreaming).toBe(true);
  });

  it('shows the optimistic spinner when a running quest is present but no streaming data resolves', () => {
    // chatCompletion.quest belongs to a different session -> streamingMessageData null,
    // while the newest cached quest is still running -> spinner should show.
    const running = makeQuest({ id: 'q-run', status: 'running', replies: [] });
    const chatCompletion = makeChatCompletion({
      quest: makeStreamQuest({ id: 'q-other', sessionId: 'other-session' }),
    });

    const { result } = renderHook(() =>
      useStreamingMessageMerge(baseParams({ flattenQuests: [running], chatCompletion }))
    );

    expect(result.current.streamingMessageData).toBeNull();
    expect(result.current.showOptimisticSpinner).toBe(true);
  });

  it('invalidates the quest query after 10s when a running quest never streams', () => {
    vi.useFakeTimers();
    const running = makeQuest({ id: 'q-run', status: 'running', replies: [] });

    renderHook(() => useStreamingMessageMerge(baseParams({ flattenQuests: [running] })));

    expect(invalidateQueries).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['quests', 'session', SESSION_ID],
    });
  });

  it('does not run the 10s safety valve once streaming data has arrived', () => {
    vi.useFakeTimers();
    const cached = makeQuest({ id: 'q1', status: 'running', replies: [] });
    const chatCompletion = makeChatCompletion({ quest: makeStreamQuest({ id: 'q1' }) });

    renderHook(() => useStreamingMessageMerge(baseParams({ flattenQuests: [cached], chatCompletion })));

    vi.advanceTimersByTime(10_000);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('clears the pending 10s safety valve when the running quest resolves before it fires', () => {
    vi.useFakeTimers();
    const running = makeQuest({ id: 'q-run', status: 'running', replies: [] });

    const { rerender } = renderHook(params => useStreamingMessageMerge(params), {
      initialProps: baseParams({ flattenQuests: [running] }),
    });

    // Advance partway - timer is pending but has not fired yet.
    vi.advanceTimersByTime(5_000);
    expect(invalidateQueries).not.toHaveBeenCalled();

    // Quest resolves to done before the 10s mark - the effect cleanup must cancel the timer.
    const done = makeQuest({ id: 'q-run', status: 'done', replies: ['answer'] });
    rerender(baseParams({ flattenQuests: [done] }));

    vi.advanceTimersByTime(10_000);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('recovers a timed-out (done+error) quest via the check-timeout poll', async () => {
    vi.useFakeTimers();
    checkQuestTimeout.mockResolvedValue({ id: 'q1', status: 'done', type: 'error' });

    const running = makeQuest({ id: 'q1', status: 'running', replies: [], timestamp: Date.now() });
    const chatCompletion = makeChatCompletion({ quest: makeStreamQuest({ id: 'q1', replies: [], status: 'running' }) });

    renderHook(() => useStreamingMessageMerge(baseParams({ flattenQuests: [running], chatCompletion })));

    // advanceTimersByTimeAsync flushes the poll interval AND the awaited async callback chain.
    await vi.advanceTimersByTimeAsync(20_000);

    expect(checkQuestTimeout).toHaveBeenCalledWith('q1');
    expect(updateAllQueryData).toHaveBeenCalled();
    expect(setChatCompletion).toHaveBeenCalledWith({ quest: undefined, completed: true, stopped: false });
    expect(resetStreaming).toHaveBeenCalledWith(SESSION_ID);
  });

  it('recovers a successfully-completed quest whose terminal WebSocket frame was lost', async () => {
    vi.useFakeTimers();
    // The generation finished on the server (status 'done', images present) but the client never
    // saw the terminal frame. The poll picks up the authoritative done state and hands it off.
    checkQuestTimeout.mockResolvedValue({ id: 'q1', status: 'done', type: 'message', images: ['dog.png'] });

    const running = makeQuest({ id: 'q1', status: 'running', replies: [], timestamp: Date.now() });
    const chatCompletion = makeChatCompletion({ quest: makeStreamQuest({ id: 'q1', replies: [], status: 'running' }) });

    renderHook(() => useStreamingMessageMerge(baseParams({ flattenQuests: [running], chatCompletion })));

    await vi.advanceTimersByTimeAsync(20_000);

    expect(updateAllQueryData).toHaveBeenCalled();
    expect(setChatCompletion).toHaveBeenCalledWith({ quest: undefined, completed: true, stopped: false });
    expect(resetStreaming).toHaveBeenCalledWith(SESSION_ID);
  });

  it('keeps polling (no handoff) while the server still reports the quest running', async () => {
    vi.useFakeTimers();
    // A live render: the backend heartbeat keeps the DB quest 'running', so check-timeout returns
    // it as-is. The client must not tear down the streaming view - it keeps polling.
    checkQuestTimeout.mockResolvedValue({ id: 'q1', status: 'running', type: 'message' });

    const running = makeQuest({ id: 'q1', status: 'running', replies: [], timestamp: Date.now() });
    const chatCompletion = makeChatCompletion({ quest: makeStreamQuest({ id: 'q1', replies: [], status: 'running' }) });

    renderHook(() => useStreamingMessageMerge(baseParams({ flattenQuests: [running], chatCompletion })));

    await vi.advanceTimersByTimeAsync(60_000);

    // Polled repeatedly (3 ticks over 60s) but never handed off.
    expect(checkQuestTimeout.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(setChatCompletion).not.toHaveBeenCalled();
    expect(resetStreaming).not.toHaveBeenCalled();
  });

  it('does not poll once the streaming quest has replies (text/chat path)', async () => {
    vi.useFakeTimers();
    const chatCompletion = makeChatCompletion({
      quest: makeStreamQuest({ id: 'q1', replies: ['partial answer'], status: 'running' }),
    });

    renderHook(() => useStreamingMessageMerge(baseParams({ flattenQuests: [], chatCompletion })));

    await vi.advanceTimersByTimeAsync(60_000);

    expect(checkQuestTimeout).not.toHaveBeenCalled();
  });
});
