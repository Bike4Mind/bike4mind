import { render, waitFor, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fresh store (DEFAULTS: no model, the 8192 max_tokens placeholder) very often gets its first model
// from session hydration (useHydrateModelFromSession -> setLLM({ model })) while admin settings are
// still loading, so the default-model effect, which raises the placeholder, never runs. The refit
// effect then saw that first model with no previous one, treated it as "the model the user is already
// on", and kept 8192 for good - on a model whose default is many times larger.
const h = vi.hoisted(() => ({ adminLoading: true }));

const OPUS = { id: 'claude-opus-x', type: 'text', contextWindow: 1_000_000, max_tokens: 128_000 };
const MINI = { id: 'gpt-5.4-mini', type: 'text', contextWindow: 400_000, max_tokens: 100_000 };
const ALL = [OPUS, MINI];

vi.mock('@/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { experimentalFeatures: {} }, isHydrated: true }),
}));
vi.mock('@/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false, isLoading: false }),
}));
vi.mock('../hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: ALL }),
}));
vi.mock('../hooks/useAccessibleModels', () => ({
  useAccessibleModels: () => ({
    accessibleModels: ALL,
    isModelAccessible: (id: string) => ALL.some(m => m.id === id),
    getFallbackModel: () => null,
  }),
}));
vi.mock('./AdminSettingsContext', () => ({
  useAdminSettings: () => ({
    getSetting: () => MINI.id,
    isLoading: h.adminLoading,
    authedSettingsLoaded: !h.adminLoading,
    error: null,
  }),
}));

import { LLMProvider, useLLM } from './LLMContext';

describe('LLMProvider refit effect - the DEFAULTS max_tokens placeholder', () => {
  beforeEach(() => {
    useLLM.getState().resetSettings();
    h.adminLoading = true;
  });
  afterEach(() => cleanup());

  it('raises the placeholder when session hydration applies the first model to a fresh store', async () => {
    expect(useLLM.getState().model).toBe('');
    expect(useLLM.getState().max_tokens).toBe(8192);

    render(<LLMProvider />);
    // What useHydrateModelFromSession does: set the model, no max_tokens.
    act(() => useLLM.getState().setLLM({ model: OPUS.id }));

    await waitFor(() => expect(useLLM.getState().max_tokens).toBe(128_000));
  });

  // The guard against over-fixing: a returning user's persisted store already has a model, and a
  // below-default value there is their own setting, which a reload must not discard.
  it('keeps a below-default value on the model the store was already on', async () => {
    useLLM.getState().setLLM({ model: OPUS.id, max_tokens: 8192 });

    render(<LLMProvider />);

    await waitFor(() => expect(useLLM.getState().model).toBe(OPUS.id));
    expect(useLLM.getState().max_tokens).toBe(8192);
  });
});

// Users the bug already reached carry the placeholder in localStorage on a model the refit effect
// will not raise on its own. The v7 migration clears that exact value so it is re-derived.
describe('llm-settings v6 -> v7 migration', () => {
  const rehydrateFrom = async (persisted: Record<string, unknown>) => {
    localStorage.setItem('llm-settings', JSON.stringify({ state: persisted, version: 6 }));
    await useLLM.persist.rehydrate();
  };
  afterEach(() => localStorage.removeItem('llm-settings'));

  it('clears a persisted placeholder so it is re-derived for the model', async () => {
    await rehydrateFrom({ model: OPUS.id, max_tokens: 8192 });

    expect(useLLM.getState().max_tokens).toBe(0);
  });

  it('keeps any other persisted value', async () => {
    await rehydrateFrom({ model: OPUS.id, max_tokens: 20_000 });

    expect(useLLM.getState().max_tokens).toBe(20_000);
  });
});
