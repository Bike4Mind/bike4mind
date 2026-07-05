import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockPushChatMessage = vi.fn().mockResolvedValue({});

vi.mock('@client/app/utils/sessionsAPICalls', () => ({
  pushChatMessage: (...args: unknown[]) => mockPushChatMessage(...args),
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

vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetFabFiles: () => ({ data: null }),
}));

vi.mock('@client/app/hooks/data/agents', () => ({
  useGetAgents: () => ({ data: [] }),
}));

vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({ data: [] }),
}));

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

vi.mock('@client/app/utils/userAPICalls', () => ({
  updateUserToServer: vi.fn().mockResolvedValue({}),
}));

// UserSettingsContext: experimentalFeatures with enableArtifacts=false (user never set it)
const mockUserSettings = {
  settings: {
    experimentalFeatures: {
      enableQuestMaster: false,
      enableMementos: false,
      enableArtifacts: false, // raw setting is false - user never explicitly enabled it
      enableAgents: false,
      enableOllama: false,
      enableResearchMode: false,
      enableDeepResearch: false,
      enableRapidReply: false,
      enableResearchEngine: false,
      enableBmPi: false,
      enableLattice: false,
    },
  },
};
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => mockUserSettings,
}));

// useFeatureEnabled: admin has default ON for artifacts, OFF for agents
const mockIsFeatureEnabled = vi.fn((feature: string) => {
  if (feature === 'enableArtifacts') return true; // admin default on
  if (feature === 'enableAgents') return false;
  return false;
});
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: mockIsFeatureEnabled, isLoading: false }),
}));

import { SessionsProvider, useSessions } from './SessionsContext';

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <SessionsProvider>{children}</SessionsProvider>
      </QueryClientProvider>
    );
  }
  return Wrapper;
}

describe('SessionsContext — addMessageToSession admin-default override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockImplementation((feature: string) => {
      if (feature === 'enableArtifacts') return true;
      if (feature === 'enableAgents') return false;
      return false;
    });
    mockPushChatMessage.mockResolvedValue({});
  });

  it('passes isFeatureEnabled result for enableArtifacts to pushChatMessage, overriding the false raw setting', async () => {
    const { result } = renderHook(() => useSessions(), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.addMessageToSession({
        sessionId: 'session-1' as unknown as import('@bike4mind/common').ISessionDocument['_id'],
        prompt: 'hello',
        timestamp: new Date(),
        role: 'user',
      });
    });

    expect(mockPushChatMessage).toHaveBeenCalledOnce();
    const [, , featureFlags] = mockPushChatMessage.mock.calls[0];
    // enableArtifacts should be true (from isFeatureEnabled admin default), not false (from raw settings)
    expect(featureFlags.enableArtifacts).toBe(true);
    // enableAgents follows isFeatureEnabled too
    expect(featureFlags.enableAgents).toBe(false);
  });
});
