import { render, waitFor, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fresh store (DEFAULTS: no model, the 8192 max_tokens placeholder) can get its first model from a
// write that leaves max_tokens alone - setLLM({ model }), which is how session hydration applied the
// pin before it moved to selectSessionModel - while admin settings are still loading, so the
// default-model effect, which raises the placeholder, never runs. The refit effect then saw that first
// model with no previous one, treated it as "the model the user is already on", and kept 8192 for good.
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

  // Today's hydration path zeroes the budget for a model other than the preferred one, so it is fitted too.
  it('fits the model default when selectSessionModel pins the first model of a fresh store', async () => {
    render(<LLMProvider />);
    act(() => useLLM.getState().selectSessionModel(OPUS.id));

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

  // Re-deriving is a model-switch rule: lowering the budget on the same model afterwards is not undone.
  it('keeps an 8192 the user sets after the placeholder was raised, across a remount', async () => {
    render(<LLMProvider />);
    act(() => useLLM.getState().setLLM({ model: OPUS.id }));
    await waitFor(() => expect(useLLM.getState().max_tokens).toBe(128_000));

    act(() => useLLM.getState().setLLM({ max_tokens: 8192 }));
    expect(useLLM.getState().max_tokens).toBe(8192);
    cleanup();
    render(<LLMProvider />);
    await act(async () => {});

    expect(useLLM.getState().max_tokens).toBe(8192);
  });
});

// Users the bug already reached carry the placeholder in localStorage on a model the refit effect
// will not raise on its own. The v7 migration clears that exact value so it is re-derived.
describe('llm-settings v6 -> v7 migration', () => {
  const rehydrateFrom = async (persisted: Record<string, unknown>, version = 6) => {
    localStorage.setItem('llm-settings', JSON.stringify({ state: persisted, version }));
    await useLLM.persist.rehydrate();
  };
  afterEach(() => {
    cleanup();
    localStorage.removeItem('llm-settings');
  });

  it('clears a persisted placeholder so it is re-derived for the model', async () => {
    await rehydrateFrom({ model: OPUS.id, max_tokens: 8192 });

    expect(useLLM.getState().max_tokens).toBe(0);
  });

  it('re-derives the cleared placeholder to the model default once the provider fits it', async () => {
    await rehydrateFrom({ model: OPUS.id, max_tokens: 8192 });

    render(<LLMProvider />);

    await waitFor(() => expect(useLLM.getState().max_tokens).toBe(128_000));
  });

  it('keeps any other persisted value, higher or lower', async () => {
    await rehydrateFrom({ model: OPUS.id, max_tokens: 20_000 });
    expect(useLLM.getState().max_tokens).toBe(20_000);

    await rehydrateFrom({ model: OPUS.id, max_tokens: 4096 });
    expect(useLLM.getState().max_tokens).toBe(4096);
  });

  // Runs once: an 8192 chosen after the migration is the user's own and must survive reloads.
  it('keeps the placeholder value in a store that is already at v7', async () => {
    await rehydrateFrom({ model: OPUS.id, max_tokens: 8192 }, 7);

    expect(useLLM.getState().max_tokens).toBe(8192);
  });

  it('writes the migrated store back at v7, so a later 8192 survives the next load', async () => {
    await rehydrateFrom({ model: OPUS.id, max_tokens: 8192 });
    expect(JSON.parse(localStorage.getItem('llm-settings') ?? '{}').version).toBe(7);

    act(() => useLLM.getState().setLLM({ max_tokens: 8192 }));
    await useLLM.persist.rehydrate();

    expect(useLLM.getState().max_tokens).toBe(8192);
  });

  // The default-model effect, the only writer of defaultTextModel, always replaces the placeholder,
  // so an 8192 beside it was set afterwards and is honored like any other explicit budget.
  it('keeps an 8192 in a store whose model the default-model effect resolved', async () => {
    await rehydrateFrom({ model: OPUS.id, defaultTextModel: OPUS.id, max_tokens: 8192 });

    expect(useLLM.getState().max_tokens).toBe(8192);
  });

  it('keeps every other persisted field', async () => {
    await rehydrateFrom({
      model: OPUS.id,
      max_tokens: 8192,
      temperature: 0.3,
      lastUsedTextModel: OPUS.id,
      tools: ['web_search'],
      output_format: 'png',
    });

    expect(useLLM.getState()).toMatchObject({
      model: OPUS.id,
      max_tokens: 0,
      temperature: 0.3,
      lastUsedTextModel: OPUS.id,
      tools: ['web_search'],
      output_format: 'png',
    });
  });

  it('falls back to defaults for a missing or corrupt entry instead of failing hydration', async () => {
    for (const persisted of [null, 'garbage', [8192]]) {
      useLLM.getState().resetSettings();
      localStorage.setItem('llm-settings', JSON.stringify({ state: persisted, version: 6 }));
      await useLLM.persist.rehydrate();

      expect(useLLM.persist.hasHydrated()).toBe(true);
      expect(useLLM.getState()).toMatchObject({ model: '', max_tokens: 8192 });
      expect(useLLM.getState()).not.toHaveProperty('0');
    }
  });
});
