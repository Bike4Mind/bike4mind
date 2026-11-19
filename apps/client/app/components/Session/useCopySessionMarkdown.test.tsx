import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCopySessionMarkdown } from './useCopySessionMarkdown';

// The main chat's current session, and a cached history for it, so every test below has a
// main-chat copy available: a getMarkdown test only proves something if it beats this one.
// `sessions` is mutable so a test can take the main session away.
const { sessions } = vi.hoisted(() => ({
  sessions: { currentSessionId: 'main-session' as string | undefined },
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => sessions,
}));
// Joins each quest's prompt in the order it receives them, so a test can pin both which
// quests reach the converter and that they arrive in chronological order.
vi.mock('@client/app/utils/sessionMarkdownExport', () => ({
  convertSessionToMarkdown: (quests: { prompt: string }[]) =>
    quests.length ? `MAIN CHAT: ${quests.map(q => q.prompt).join(',')}` : '',
}));

const writeText = vi.fn<(text: string) => Promise<void>>();

let queryClient: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  sessions.currentSessionId = 'main-session';
  queryClient = new QueryClient();
  // Newest page first, newest item first: the hook reverses this into chronological order.
  queryClient.setQueryData(['quests', 'session', 'main-session'], {
    pages: [{ data: [{ prompt: 'third' }, { prompt: 'second' }] }, { data: [{ prompt: 'first' }] }],
    pageParams: [],
  });
});

describe('useCopySessionMarkdown', () => {
  it("copies the main chat's current session when no getMarkdown is given", async () => {
    const { result } = renderHook(() => useCopySessionMarkdown(), { wrapper });

    await act(() => result.current.copyMarkdown());

    expect(writeText).toHaveBeenCalledWith('MAIN CHAT: first,second,third');
    expect(result.current.copied).toBe(true);
  });

  it("copies getMarkdown's text instead of the main chat's session", async () => {
    const { result } = renderHook(() => useCopySessionMarkdown(() => 'OVERLAY CHAT'), { wrapper });

    await act(() => result.current.copyMarkdown());

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('OVERLAY CHAT');
    expect(result.current.copied).toBe(true);
  });

  it('copies getMarkdown text when the main chat has no current session', async () => {
    sessions.currentSessionId = undefined;
    const { result } = renderHook(() => useCopySessionMarkdown(() => 'OVERLAY CHAT'), { wrapper });

    await act(() => result.current.copyMarkdown());

    expect(writeText).toHaveBeenCalledWith('OVERLAY CHAT');
    expect(result.current.copied).toBe(true);
  });

  it('copies nothing with no getMarkdown and no current session', async () => {
    sessions.currentSessionId = undefined;
    const { result } = renderHook(() => useCopySessionMarkdown(), { wrapper });

    await act(() => result.current.copyMarkdown());

    expect(writeText).not.toHaveBeenCalled();
    expect(result.current.copied).toBe(false);
  });

  // Changed from main, where an empty session wrote '' to the clipboard and showed the tick.
  it('copies nothing and shows no tick for an empty main-chat session', async () => {
    queryClient.setQueryData(['quests', 'session', 'main-session'], { pages: [{ data: [] }], pageParams: [] });
    const { result } = renderHook(() => useCopySessionMarkdown(), { wrapper });

    await act(() => result.current.copyMarkdown());

    expect(writeText).not.toHaveBeenCalled();
    expect(result.current.copied).toBe(false);
  });

  it('copies the latest getMarkdown after a rerender', async () => {
    const { result, rerender } = renderHook(({ fn }) => useCopySessionMarkdown(fn), {
      wrapper,
      initialProps: { fn: () => 'FIRST' },
    });
    rerender({ fn: () => 'SECOND' });

    await act(() => result.current.copyMarkdown());

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('SECOND');
  });

  it('waits for an async getMarkdown', async () => {
    const { result } = renderHook(() => useCopySessionMarkdown(async () => 'LOADED CHAT'), { wrapper });

    await act(() => result.current.copyMarkdown());

    expect(writeText).toHaveBeenCalledWith('LOADED CHAT');
  });

  // An empty overlay chat must not fall back to copying the main chat, and must not show
  // the "Copied!" tick for a copy that never happened.
  it.each([
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('copies nothing when getMarkdown returns %s', async (_label, empty) => {
    const { result } = renderHook(() => useCopySessionMarkdown(() => empty), { wrapper });

    await act(() => result.current.copyMarkdown());

    expect(writeText).not.toHaveBeenCalled();
    expect(result.current.copied).toBe(false);
  });

  it('does not show the tick when getMarkdown throws, and logs the error', async () => {
    const boom = new Error('boom');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = renderHook(
        () =>
          useCopySessionMarkdown(() => {
            throw boom;
          }),
        { wrapper }
      );

      await act(() => result.current.copyMarkdown());

      expect(writeText).not.toHaveBeenCalled();
      expect(result.current.copied).toBe(false);
      expect(consoleError).toHaveBeenCalledWith('Failed to copy markdown:', boom);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not show the tick when the clipboard write is rejected', async () => {
    const denied = new Error('NotAllowedError');
    writeText.mockRejectedValueOnce(denied);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useCopySessionMarkdown(() => 'OVERLAY CHAT'), { wrapper });

      await act(() => result.current.copyMarkdown());

      expect(writeText).toHaveBeenCalledWith('OVERLAY CHAT');
      expect(result.current.copied).toBe(false);
      expect(consoleError).toHaveBeenCalledWith('Failed to copy markdown:', denied);
    } finally {
      consoleError.mockRestore();
    }
  });
});
