import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ISessionDocument } from '@bike4mind/common';

// changeSession reads the user through the provider's non-reactive `useUser.getState()`
// snapshot, so the write only fires when this mock carries a lastNotebookId that differs
// from the session being opened.
const mocks = vi.hoisted(() => ({
  currentUser: { id: 'u1', lastNotebookId: 'session-old' } as { id: string; lastNotebookId: string | null },
  updateUserToServer: vi.fn(),
}));

vi.mock('@client/app/utils/userAPICalls', () => ({ updateUserToServer: mocks.updateUserToServer }));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: Object.assign(vi.fn().mockReturnValue(null), { getState: () => ({ currentUser: mocks.currentUser }) }),
}));

vi.mock('@client/app/utils/sessionsAPICalls', () => ({
  pushChatMessage: vi.fn().mockResolvedValue({}),
  updateSessionToServer: vi.fn().mockResolvedValue({}),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: vi.fn().mockResolvedValue({ data: {} }), get: vi.fn().mockResolvedValue({ data: {} }) },
}));

vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector?: (s: Record<string, unknown>) => unknown): unknown => {
    const state: Record<string, unknown> = { setLLM: vi.fn(), tools: [], isQuestMasterEnabled: false };
    return selector ? selector(state) : state;
  },
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

vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { experimentalFeatures: {} } }),
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false, isLoading: false }),
}));

import { SessionsProvider, useSessions } from './SessionsContext';

const NEW_SESSION_ID = 'session-new';

/**
 * getOrFetchSession resolves through `ensureQueryData`, so seeding the cache is enough to
 * open a session without a network mock (staleTime is 30 minutes, so the entry stays fresh).
 */
function renderSessions() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['sessions', NEW_SESSION_ID], { id: NEW_SESSION_ID } as unknown as ISessionDocument);
  const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

  const rendered = renderHook(() => useSessions(), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>
        <SessionsProvider>{children}</SessionsProvider>
      </QueryClientProvider>
    ),
  });

  return { ...rendered, invalidateSpy };
}

describe('SessionsContext - lastNotebookId write on session switch', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  /**
   * Only the calls this fix is responsible for. Counting every console.error would make the
   * test hostage to unrelated logging from anything else the provider renders.
   */
  const lastNotebookErrors = () =>
    errorSpy.mock.calls.filter(([message]) => 'string' === typeof message && message.includes('lastNotebookId'));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser = { id: 'u1', lastNotebookId: 'session-old' };
    mocks.updateUserToServer.mockResolvedValue({});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('persists the newly opened session as lastNotebookId', async () => {
    const { result, invalidateSpy } = renderSessions();

    await act(async () => {
      await result.current.changeSession(NEW_SESSION_ID);
    });

    expect(mocks.updateUserToServer).toHaveBeenCalledWith('u1', { lastNotebookId: NEW_SESSION_ID });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sessions', NEW_SESSION_ID] });
    expect(result.current.currentSessionId).toBe(NEW_SESSION_ID);
    // A handler that logged unconditionally would satisfy the failure test below.
    expect(lastNotebookErrors()).toHaveLength(0);
  });

  it('skips the write when the user is already on that notebook', async () => {
    mocks.currentUser = { id: 'u1', lastNotebookId: NEW_SESSION_ID };
    const { result } = renderSessions();

    await act(async () => {
      await result.current.changeSession(NEW_SESSION_ID);
    });

    expect(mocks.updateUserToServer).not.toHaveBeenCalled();
    expect(result.current.currentSessionId).toBe(NEW_SESSION_ID);
  });

  // The bug (#1552): the write was fire-and-forget with no rejection handler at all, so a
  // non-2xx escaped as an unhandled rejection. Asserting the log is what pins that - an
  // escaped rejection alone does not fail a vitest run (the process exits before node emits
  // `unhandledRejection`), so a test that only awaited changeSession would pass either way.
  it('handles a rejected write instead of leaking an unhandled rejection', async () => {
    const failure = new Error('boom');
    mocks.updateUserToServer.mockRejectedValue(failure);
    const { result } = renderSessions();

    await act(async () => {
      // Resolving matters: the write is deliberately not awaited, so awaiting it (without a
      // catch) would surface the failure as a rejected changeSession and break the switch.
      await expect(result.current.changeSession(NEW_SESSION_ID)).resolves.toBeUndefined();
    });

    expect(lastNotebookErrors()).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('lastNotebookId'), failure);
  });

  it('still switches session when the write fails', async () => {
    mocks.updateUserToServer.mockRejectedValue(new Error('boom'));
    const { result } = renderSessions();

    await act(async () => {
      await result.current.changeSession(NEW_SESSION_ID);
    });

    expect(result.current.currentSessionId).toBe(NEW_SESSION_ID);
    expect(result.current.currentSession?.id).toBe(NEW_SESSION_ID);
  });
});
