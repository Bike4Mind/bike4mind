import { createElement } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ISessionDocument, ModelInfo } from '@bike4mind/common';
import { buildModelSelectionPatch } from '@client/app/utils/aiSettingsUtils';
import { useHydrateModelFromSession } from '../components/Session/AISettings/useHydrateModelFromSession';
import { LLMProvider, useLLM } from './LLMContext';

const h = vi.hoisted(() => ({ models: [] as ModelInfo[] }));
vi.mock('@/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { experimentalFeatures: {} }, isHydrated: true }),
}));
vi.mock('@/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false, isLoading: false }),
}));
vi.mock('../hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: h.models }) }));
vi.mock('../hooks/useAccessibleModels', () => ({
  useAccessibleModels: () => ({
    accessibleModels: h.models,
    isModelAccessible: (id: string) => h.models.some(model => model.id === id),
    getFallbackModel: () => null,
    isEntitlementsLoading: false,
  }),
}));
vi.mock('./AdminSettingsContext', () => ({
  useAdminSettings: () => ({
    getSetting: () => 'preferred',
    isLoading: false,
    authedSettingsLoaded: true,
    error: null,
  }),
}));

const preferred = {
  id: 'preferred',
  name: 'Preferred',
  type: 'text',
  contextWindow: 200_000,
  max_tokens: 32_768,
} as ModelInfo;
const affordable = { ...preferred, id: 'affordable', max_tokens: 16_384 };
type Session = Pick<ISessionDocument, 'id' | 'lastUsedModel'> | null;
const selectPinnedModel = (model: string) => useLLM.getState().selectSessionModel(model);
const restorePreferredModel = () => useLLM.getState().selectSessionModel(null);
const session = (id: string, model: string | null): Session => ({ id, lastUsedModel: model }) as Session;

const readPersisted = () => {
  const persisted: unknown = JSON.parse(localStorage.getItem('llm-settings') ?? '{}');
  return persisted;
};

describe('chat model overrides', () => {
  beforeEach(() => {
    h.models = [preferred, affordable];
    localStorage.clear();
    useLLM.getState().resetSettings();
    useLLM.getState().setLLM({ ...buildModelSelectionPatch(preferred), max_tokens: 4096, temperature: 0.4 });
  });

  it('uses the affordable model for requests while preserving the preferred default on disk', () => {
    useLLM.getState().selectSessionModel(affordable.id, affordable);
    expect(useLLM.getState()).toMatchObject({
      model: affordable.id,
      max_tokens: affordable.max_tokens,
      lastUsedTextModel: preferred.id,
    });
    // Unrelated settings and provider refits also persist through Zustand middleware.
    useLLM.setState({ max_tokens: 8000, tools: [] });
    expect(readPersisted()).toMatchObject({
      state: { model: preferred.id, lastUsedTextModel: preferred.id, max_tokens: 4096, temperature: 0.4 },
    });
  });

  it('restores the preferred default on reload, then hydrates this chat without changing that default', async () => {
    useLLM.getState().selectSessionModel(affordable.id, affordable);
    const snapshot = localStorage.getItem('llm-settings');
    expect(snapshot).not.toBeNull();
    useLLM.getState().resetSettings();
    localStorage.setItem('llm-settings', snapshot!);
    await useLLM.persist.rehydrate();
    expect(useLLM.getState()).toMatchObject({ model: preferred.id, max_tokens: 4096, sessionModelOverride: null });

    renderHook(() =>
      useHydrateModelFromSession(session('chat-a', affordable.id), selectPinnedModel, restorePreferredModel)
    );
    expect(useLLM.getState().model).toBe(affordable.id);
    expect(readPersisted()).toMatchObject({ state: { model: preferred.id, max_tokens: 4096 } });
  });

  it('persists settings edited after resuming a chat on the preferred model', async () => {
    renderHook(() =>
      useHydrateModelFromSession(session('chat-a', preferred.id), selectPinnedModel, restorePreferredModel)
    );
    act(() => useLLM.getState().setLLM({ max_tokens: 2048, temperature: 0.2 }));
    expect(readPersisted()).toMatchObject({ state: { model: preferred.id, max_tokens: 2048, temperature: 0.2 } });

    const snapshot = localStorage.getItem('llm-settings');
    useLLM.getState().resetSettings();
    localStorage.setItem('llm-settings', snapshot!);
    await useLLM.persist.rehydrate();
    expect(useLLM.getState()).toMatchObject({ model: preferred.id, max_tokens: 2048, temperature: 0.2 });
  });

  it('restores each chat pin and returns to the preferred model for a new unpinned chat', () => {
    const { rerender } = renderHook(
      ({ currentSession }: { currentSession: Session }) =>
        useHydrateModelFromSession(currentSession, selectPinnedModel, restorePreferredModel),
      { initialProps: { currentSession: session('chat-a', preferred.id) } }
    );
    act(() => useLLM.getState().selectSessionModel(affordable.id, affordable));
    rerender({ currentSession: session('chat-a', preferred.id) });
    expect(useLLM.getState().model).toBe(affordable.id);
    rerender({ currentSession: session('chat-b', 'other-chat-model') });
    expect(useLLM.getState().model).toBe('other-chat-model');
    rerender({ currentSession: session('chat-a', affordable.id) });
    expect(useLLM.getState().model).toBe(affordable.id);
    rerender({ currentSession: session('new-chat', null) });
    expect(useLLM.getState()).toMatchObject({ model: preferred.id, max_tokens: 4096, sessionModelOverride: null });
    // A delayed pin may still arrive after the session document.
    rerender({ currentSession: session('new-chat', affordable.id) });
    expect(useLLM.getState().model).toBe(affordable.id);
    rerender({ currentSession: null });
    expect(useLLM.getState()).toMatchObject({ model: preferred.id, max_tokens: 4096, temperature: 0.4 });
  });

  it('fits the chat output limit without raising the preferred limit when leaving that chat', () => {
    const { unmount } = render(createElement(LLMProvider));
    act(() => useLLM.getState().selectSessionModel(affordable.id, affordable));
    expect(useLLM.getState().max_tokens).toBe(affordable.max_tokens);
    act(() => useLLM.getState().selectSessionModel(null));
    expect(useLLM.getState()).toMatchObject({ model: preferred.id, max_tokens: 4096 });
    unmount();
  });

  it('ordinary picker selections replace the preferred default even during an override', () => {
    useLLM.getState().selectSessionModel(affordable.id, affordable);
    // AdvancedAIModal uses the raw setState API with this shared patch.
    useLLM.setState(buildModelSelectionPatch({ ...preferred, id: 'new-preferred' }));
    useLLM.getState().selectSessionModel(null);
    expect(useLLM.getState()).toMatchObject({ model: 'new-preferred', sessionModelOverride: null });
    expect(readPersisted()).toMatchObject({ state: { model: 'new-preferred', lastUsedTextModel: 'new-preferred' } });
  });
});
