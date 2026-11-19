import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCopySessionMarkdown } from './useCopySessionMarkdown';

// The main chat's current session, and a cached history for it, so every test below has a
// main-chat copy available: a getMarkdown test only proves something if it beats this one.
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: 'main-session' }),
}));
vi.mock('@client/app/utils/sessionMarkdownExport', () => ({
  convertSessionToMarkdown: () => 'MAIN CHAT MARKDOWN',
}));

const writeText = vi.fn<(text: string) => Promise<void>>();

let queryClient: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  queryClient = new QueryClient();
  queryClient.setQueryData(['quests', 'session', 'main-session'], { pages: [{ data: [] }], pageParams: [] });
});

describe('useCopySessionMarkdown', () => {
  it("copies the main chat's current session when no getMarkdown is given", async () => {
    const { result } = renderHook(() => useCopySessionMarkdown(), { wrapper });

    await act(() => result.current.copyMarkdown());

    expect(writeText).toHaveBeenCalledWith('MAIN CHAT MARKDOWN');
    expect(result.current.copied).toBe(true);
  });

  it("copies getMarkdown's text instead of the main chat's session", async () => {
    const { result } = renderHook(() => useCopySessionMarkdown(() => 'ASK BOB CHAT'), { wrapper });

    await act(() => result.current.copyMarkdown());

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('ASK BOB CHAT');
    expect(result.current.copied).toBe(true);
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

  it('does not show the tick when getMarkdown throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(
      () =>
        useCopySessionMarkdown(() => {
          throw new Error('boom');
        }),
      { wrapper }
    );

    await act(() => result.current.copyMarkdown());

    expect(writeText).not.toHaveBeenCalled();
    expect(result.current.copied).toBe(false);
    consoleError.mockRestore();
  });
});
