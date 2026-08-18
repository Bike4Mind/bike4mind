import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { IFabFileDocument, ISessionDocument } from '@bike4mind/common';

const mockGetFabFilesByIds = vi.fn();

vi.mock('@client/app/utils/filesAPICalls', () => ({
  getFabFilesFromServerByIds: (ids: string[]) => mockGetFabFilesByIds(ids),
}));

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

vi.mock('@client/app/utils/userAPICalls', () => ({ updateUserToServer: vi.fn().mockResolvedValue({}) }));

vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { experimentalFeatures: {} } }),
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false, isLoading: false }),
}));

import { SessionsProvider, useSessions, useWorkBenchStore } from './SessionsContext';

const SESSION_ID = 'session-1';

const fabFile = (id: string): IFabFileDocument =>
  ({ id, fileName: `${id}.pdf`, mimeType: 'application/pdf' }) as IFabFileDocument;

const sessionWith = (knowledgeIds: string[]): ISessionDocument =>
  ({ id: SESSION_ID, knowledgeIds }) as unknown as ISessionDocument;

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <SessionsProvider>{children}</SessionsProvider>
      </QueryClientProvider>
    );
  };
}

const workbenchIds = () => (useWorkBenchStore.getState().getWorkBenchFiles(SESSION_ID) ?? []).map(f => f.id);

async function hydrate(result: { current: ReturnType<typeof useSessions> }, knowledgeIds: string[]) {
  await act(async () => {
    result.current.setCurrentSessionId(SESSION_ID);
    result.current.setCurrentSession(sessionWith(knowledgeIds));
  });
}

describe('SessionsContext workbench hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkBenchStore.setState({ sessionStates: {} });
  });

  it('hydrates the workbench in knowledgeIds order, not fetch-response order', async () => {
    // The server is free to return $in results in any order; knowledgeIds is the
    // ordering that must survive, because the next write rebuilds it from the workbench.
    mockGetFabFilesByIds.mockResolvedValue([fabFile('c'), fabFile('a'), fabFile('b')]);

    const { result } = renderHook(() => useSessions(), { wrapper: makeWrapper() });
    await hydrate(result, ['a', 'b', 'c']);

    await waitFor(() => expect(workbenchIds()).toEqual(['a', 'b', 'c']));
  });

  it('drops a knowledgeId the server cannot resolve rather than leaving a hole', async () => {
    mockGetFabFilesByIds.mockResolvedValue([fabFile('a')]);

    const { result } = renderHook(() => useSessions(), { wrapper: makeWrapper() });
    await hydrate(result, ['a', 'deleted-file']);

    await waitFor(() => expect(workbenchIds()).toEqual(['a']));
  });

  it('ignores a stale hydration that resolves after a newer one started', async () => {
    // The guard this locks: without a generation check the slow first fetch lands last
    // and overwrites the workbench with the OLDER knowledgeIds set. The next
    // knowledgeIds write is rebuilt from that bucket, so the dropped file is persisted
    // as gone - a lost update, not just a stale render.
    let releaseFirst: (v: IFabFileDocument[]) => void = () => {};
    const firstFetch = new Promise<IFabFileDocument[]>(resolve => {
      releaseFirst = resolve;
    });

    mockGetFabFilesByIds.mockReturnValueOnce(firstFetch).mockResolvedValueOnce([fabFile('a'), fabFile('b')]);

    const { result } = renderHook(() => useSessions(), { wrapper: makeWrapper() });

    await hydrate(result, ['a']);
    await hydrate(result, ['a', 'b']);
    await waitFor(() => expect(workbenchIds()).toEqual(['a', 'b']));

    await act(async () => {
      releaseFirst([fabFile('a')]);
      await firstFetch;
    });

    expect(workbenchIds()).toEqual(['a', 'b']);
  });
});
