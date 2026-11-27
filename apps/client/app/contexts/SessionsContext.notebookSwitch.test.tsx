import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockSetLLM = vi.fn();
const mockSelectSessionModel = vi.fn();
let mockTools: string[] = [];

vi.mock('@client/app/utils/sessionsAPICalls', () => ({
  pushChatMessage: vi.fn().mockResolvedValue({}),
  updateSessionToServer: vi.fn().mockResolvedValue({}),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: vi.fn().mockResolvedValue({ data: {} }), get: vi.fn().mockResolvedValue({ data: {} }) },
}));

vi.mock('@client/app/contexts/UserContext', () => {
  const mockGetState = () => ({ currentUser: { id: 'u1' } });
  const useUser = Object.assign(vi.fn().mockReturnValue(null), { getState: mockGetState });
  return { useUser };
});

vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown): unknown => {
      const state: Record<string, unknown> = {
        setLLM: mockSetLLM,
        selectSessionModel: mockSelectSessionModel,
        tools: mockTools,
      };
      return selector ? selector(state) : state;
    },
    { getState: () => ({ hasExplicitSessionModelSelection: false }) }
  ),
}));

vi.mock('@client/app/hooks/data/fabFiles', () => ({ useGetFabFiles: () => ({ data: null }) }));
vi.mock('@client/app/hooks/data/agents', () => ({ useGetAgents: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/data/settings', () => ({ useSettingsFromServer: () => ({ data: [] }) }));

vi.mock('@client/app/utils/react-query', () => ({
  updateAllQueryData: vi.fn(),
  useSubscribeCollection: vi.fn(),
}));

vi.mock('../utils/dexie', () => ({
  dexie: {
    fabFiles: {
      where: vi.fn().mockReturnThis(),
      anyOf: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('@client/app/utils/userAPICalls', () => ({ updateUserToServer: vi.fn().mockResolvedValue({}) }));

vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { experimentalFeatures: {} } }),
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false, isLoading: false }),
}));

import { SessionsProvider, useSessions } from './SessionsContext';

const DEEP_RESEARCH_TOAST = 'Deep Research disabled when switching notebooks. Re-enable in tools if needed.';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useSessions(), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>
        <SessionsProvider>{children}</SessionsProvider>
      </QueryClientProvider>
    ),
  });
}

function toastMessages(listener: ReturnType<typeof vi.fn>): unknown[] {
  return listener.mock.calls.map(([event]) => (event as CustomEvent<{ message: string }>).detail.message);
}

describe('SessionsContext - deep research auto-disable on notebook switch', () => {
  const toastListener = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    mockSetLLM.mockReset();
    toastListener.mockReset();
    window.addEventListener('show-toast', toastListener);
  });

  afterEach(() => {
    window.removeEventListener('show-toast', toastListener);
    vi.useRealTimers();
  });

  it('drops deep_research from the tools and shows the toast when switching from notebook A to B', () => {
    mockTools = ['deep_research', 'web_search'];
    const { result } = setup();

    act(() => result.current.setCurrentSessionId('notebook-a'));
    expect(mockSetLLM).not.toHaveBeenCalled();

    act(() => result.current.setCurrentSessionId('notebook-b'));
    expect(mockSetLLM).toHaveBeenCalledTimes(1);
    expect(mockSetLLM).toHaveBeenCalledWith({ tools: ['web_search'] });

    // The toast is deferred, so nothing fires until the timer elapses.
    expect(toastListener).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1000));
    expect(toastMessages(toastListener)).toEqual([DEEP_RESEARCH_TOAST]);
  });

  it('leaves the tools alone and shows no toast when deep_research is not enabled', () => {
    mockTools = ['web_search'];
    const { result } = setup();

    act(() => result.current.setCurrentSessionId('notebook-a'));
    act(() => result.current.setCurrentSessionId('notebook-b'));
    act(() => vi.advanceTimersByTime(5000));

    expect(mockSetLLM).not.toHaveBeenCalled();
    expect(toastListener).not.toHaveBeenCalled();
  });
});
