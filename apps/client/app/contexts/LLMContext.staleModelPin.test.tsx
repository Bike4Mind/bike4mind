import { render, waitFor, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A model id can become unresolvable AFTER the default-model effect has already settled: session
// hydration (useHydrateModelFromSession) writes `lastUsedModel` unvalidated, and the persisted store
// rehydrates one on its own. The effect that repairs an inaccessible model must therefore watch the
// model itself, not only the inputs it resolves one from - otherwise the bad id sticks for the life of
// the tab, blanks the composer's model chip, and blocks every send with a zero context window.
//
// Fixture note (same contract as LLMContext.fallbackCeiling.test.tsx): `accessibleModels` must stay
// consistent with `isModelAccessible`. The real hook builds the list BY that predicate, so a model
// cannot be in the list while the predicate rejects it. A model absent from the catalog is exactly how
// the predicate returns false.
const h = vi.hoisted(() => ({
  adminDefaultModel: 'gpt-5.4-mini',
  accessibleIds: ['gpt-5.4-mini'] as string[],
  liveCatalogIds: ['gpt-5.4-mini', 'gpt-5.6-terra'] as string[],
}));

const MINI = { id: 'gpt-5.4-mini', type: 'text', contextWindow: 400_000, max_tokens: 100_000 };
const TERRA = { id: 'gpt-5.6-terra', type: 'text', contextWindow: 1_050_000, max_tokens: 128_000 };
const ALL = [MINI, TERRA];

// The id the session pins: a real model that the live catalog no longer serves.
const RETIRED_PIN = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

vi.mock('@/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { experimentalFeatures: {} }, isHydrated: true }),
}));
vi.mock('@/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false, isLoading: false }),
}));
// The real hooks useMemo their lists, so a re-render hands back the SAME array reference. Reproducing
// that here is what makes this file a test of the effect's dep array rather than of the mock: a fresh
// array per render would re-fire the effect on every commit and repair the pin for the wrong reason.
const stableList = (() => {
  const cache = new Map<string, typeof ALL>();
  return (ids: string[]) => {
    const key = ids.join(',');
    const hit = cache.get(key);
    if (hit) return hit;
    const built = ALL.filter(m => ids.includes(m.id));
    cache.set(key, built);
    return built;
  };
})();

vi.mock('../hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: stableList(h.liveCatalogIds) }),
}));
vi.mock('../hooks/useAccessibleModels', () => ({
  useAccessibleModels: () => ({
    accessibleModels: stableList(h.accessibleIds),
    isModelAccessible: (id: string) => h.accessibleIds.includes(id),
    getFallbackModel: () => null,
  }),
}));
vi.mock('./AdminSettingsContext', () => ({
  useAdminSettings: () => ({ getSetting: () => h.adminDefaultModel, isLoading: false }),
}));

import { LLMProvider, useLLM } from './LLMContext';

describe('LLMProvider default-model effect - a model that goes unresolvable after the effect settled', () => {
  beforeEach(() => {
    useLLM.getState().resetSettings();
    h.adminDefaultModel = MINI.id;
    h.accessibleIds = [MINI.id, TERRA.id];
    h.liveCatalogIds = ALL.map(m => m.id);
  });
  afterEach(() => cleanup());

  it('repairs a pin written after mount, so a session cannot strand the composer on a dead model', async () => {
    render(<LLMProvider />);
    // Let the effect resolve a real model first. Everything it keys on is settled from here on, which
    // is the whole point: the repair below cannot come from any of those inputs changing.
    await waitFor(() => expect(useLLM.getState().model).toBe(MINI.id));

    // Session hydration: useHydrateModelFromSession applies `lastUsedModel` with no validation.
    act(() => {
      useLLM.getState().setLLM({ model: RETIRED_PIN });
    });

    await waitFor(() => expect(useLLM.getState().model).toBe(MINI.id));
  });

  it('preserves a lowered max_tokens while repairing the pin', async () => {
    // The repair hands the refit effect a `from` id that effect never fitted (a dead pin is absent
    // from modelInfoRepo, so it bails before recording it). If the handshake misses, the refit effect
    // reads the landing as a user-initiated switch and raises the ceiling back to the new model's
    // default - silently discarding a value the user lowered on purpose.
    render(<LLMProvider />);
    await waitFor(() => expect(useLLM.getState().model).toBe(MINI.id));

    act(() => {
      useLLM.getState().setLLM({ max_tokens: 4096 });
    });
    // Make the repair land on a DIFFERENT model than the one in refitModelRef, which is what turns
    // the missed handshake into an observable raise.
    h.adminDefaultModel = TERRA.id;

    act(() => {
      useLLM.getState().setLLM({ model: RETIRED_PIN });
    });

    await waitFor(() => expect(useLLM.getState().model).toBe(TERRA.id));
    expect(useLLM.getState().max_tokens).toBe(4096);
  });

  it('leaves a model the user picked after mount alone', async () => {
    // The guard against over-fixing: the repair must fire on unresolvable ids only, never undo a
    // deliberate switch to another accessible model.
    render(<LLMProvider />);
    await waitFor(() => expect(useLLM.getState().model).toBe(MINI.id));

    act(() => {
      useLLM.getState().setLLM({ model: TERRA.id });
    });

    await waitFor(() => expect(useLLM.getState().model).toBe(TERRA.id));
    expect(useLLM.getState().model).toBe(TERRA.id);
  });
});
