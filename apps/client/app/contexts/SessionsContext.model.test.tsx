import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ISessionDocument } from '@bike4mind/common';

const mockGetFabFilesByIds = vi.fn().mockResolvedValue([]);
const mockGetOrFetchSession = vi.fn();

vi.mock('@client/app/hooks/data/sessions', () => ({
  getOrFetchSession: (...args: unknown[]) => mockGetOrFetchSession(...args),
}));

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
  const useUser = Object.assign(
    vi.fn((selector: (state: ReturnType<typeof mockGetState>) => unknown) => selector(mockGetState())),
    {
      getState: mockGetState,
    }
  );
  return { useUser };
});

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
import { useLLM } from './LLMContext';
import { useAffordableModelOffer } from '../components/Session/useAffordableModelOffer';
import { buildModelSelectionPatch } from '../utils/aiSettingsUtils';
import type { ModelInfo } from '@bike4mind/common';

const preferred = { id: 'preferred', type: 'text', contextWindow: 200_000, max_tokens: 32_768 } as ModelInfo;
const affordable = { ...preferred, id: 'affordable', max_tokens: 16_384 };
const session = (id: string, lastUsedModel: string | null) =>
  ({ id, lastUsedModel, knowledgeIds: [] }) as unknown as ISessionDocument;

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(
    () => {
      const sessions = useSessions();
      const offer = useAffordableModelOffer({
        enforceCredits: true,
        modelsLoaded: true,
        selectedModelId: useLLM(state => state.model),
        sessionId: sessions.currentSessionId,
      });
      return { sessions, offer };
    },
    {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <SessionsProvider>{children}</SessionsProvider>
        </QueryClientProvider>
      ),
    }
  );
}

describe('session model lifecycle without a mounted toolbar', () => {
  beforeEach(() => {
    mockGetOrFetchSession.mockReset();
    useLLM.getState().resetSettings();
    useLLM.setState({ ...buildModelSelectionPatch(preferred), max_tokens: 4096 });
  });

  it('keeps an affordable /new pick through optimistic creation and restores the default on the next /new', () => {
    const { result } = setup();
    act(() => result.current.offer.onSelect(affordable));
    expect(useLLM.getState().model).toBe(affordable.id);

    act(() => {
      result.current.sessions.setCurrentSessionId('optimistic-session-new');
      result.current.sessions.setCurrentSessionRaw(session('optimistic-session-new', null));
    });
    expect(useLLM.getState().model).toBe(affordable.id);
    act(() => {
      result.current.sessions.setCurrentSessionId('created-chat');
      result.current.sessions.setCurrentSessionRaw(session('created-chat', null));
    });
    expect(useLLM.getState().model).toBe(affordable.id);
    // The first turn's eventual pin must not change the global preference.
    act(() => result.current.sessions.setCurrentSessionRaw(session('created-chat', affordable.id)));
    expect(useLLM.getState().model).toBe(affordable.id);
    act(() => {
      result.current.sessions.setCurrentSessionId(null);
      result.current.sessions.setCurrentSessionRaw(null);
    });
    expect(useLLM.getState()).toMatchObject({ model: preferred.id, max_tokens: 4096 });
  });

  it('restores the default when a failed optimistic first chat is abandoned for /new', () => {
    const { result } = setup();
    act(() => result.current.offer.onSelect(affordable));
    act(() => {
      result.current.sessions.setCurrentSessionId('optimistic-session-failed');
      result.current.sessions.setCurrentSessionRaw(session('optimistic-session-failed', null));
    });
    expect(useLLM.getState().model).toBe(affordable.id);

    // Failed sends keep their optimistic chat so its error remains visible. No real id arrives.
    act(() => {
      result.current.sessions.setCurrentSessionId(null);
      result.current.sessions.setCurrentSessionRaw(null);
    });
    expect(useLLM.getState()).toMatchObject({ model: preferred.id, max_tokens: 4096, sessionModelOverride: null });
  });

  it('adopts an existing chat pin when navigating directly from a failed optimistic chat', async () => {
    const { result } = setup();
    act(() => result.current.offer.onSelect(affordable));
    act(() => {
      result.current.sessions.setCurrentSessionId('optimistic-session-failed');
      result.current.sessions.setCurrentSessionRaw(session('optimistic-session-failed', null));
    });
    mockGetOrFetchSession.mockResolvedValue(session('existing-chat', 'existing-pinned-model'));

    await act(async () => result.current.sessions.changeSession('existing-chat'));
    expect(useLLM.getState().model).toBe('existing-pinned-model');
  });

  it.each(['offer', 'picker'] as const)('keeps a %s selection when a delayed stale session pin arrives', source => {
    const { result } = setup();
    act(() => result.current.sessions.setCurrentSessionId('loading-chat'));
    act(() => {
      if (source === 'offer') result.current.offer.onSelect(affordable);
      else useLLM.setState(buildModelSelectionPatch(affordable));
    });
    act(() => result.current.sessions.setCurrentSessionRaw(session('loading-chat', preferred.id)));
    expect(useLLM.getState().model).toBe(affordable.id);

    // Ownership ends with the chat; it cannot suppress another chat's pin.
    act(() => {
      result.current.sessions.setCurrentSessionId('next-chat');
      result.current.sessions.setCurrentSessionRaw(session('next-chat', 'next-pinned-model'));
    });
    expect(useLLM.getState().model).toBe('next-pinned-model');
  });

  it('clears the old override before the next document arrives and adopts its delayed pin', () => {
    const { result } = setup();
    act(() => {
      result.current.sessions.setCurrentSessionId('chat-a');
      result.current.sessions.setCurrentSessionRaw(session('chat-a', preferred.id));
    });
    act(() => result.current.offer.onSelect(affordable));
    act(() => result.current.sessions.setCurrentSessionId('chat-b'));
    expect(useLLM.getState()).toMatchObject({ model: preferred.id, max_tokens: 4096 });
    act(() => result.current.sessions.setCurrentSessionRaw(session('chat-b', 'other-pinned-model')));
    expect(useLLM.getState().model).toBe('other-pinned-model');
    const persisted: unknown = JSON.parse(localStorage.getItem('llm-settings') ?? '{}');
    expect(persisted).toMatchObject({ state: { model: preferred.id, lastUsedTextModel: preferred.id } });
  });
});
