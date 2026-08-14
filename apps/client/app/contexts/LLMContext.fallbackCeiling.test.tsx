import { render, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #1254: the default-model effect resolves a replacement model on the user's behalf (their model was
// unset or failed the accessibility predicate) and used to stamp that model's DEFAULT ceiling over a
// deliberately lowered value. These tests drive the real effect through LLMProvider, since the pure
// aiSettingsUtils tests cannot reach it.
//
// Fixture note, and the reason an earlier version of this file was deleted: `accessibleModels` must
// stay CONSISTENT with `isModelAccessible`. The real hook builds that list BY that predicate
// (useAccessibleModels.ts), so a model cannot be in the list while the predicate rejects it. Here the
// user's model is simply absent from the list, which is exactly how the predicate returns false.
const h = vi.hoisted(() => ({
  adminDefaultModel: 'gpt-5.4-mini',
  // Ids the accessibility predicate accepts. Kept as one source so the predicate and the list it
  // builds can never disagree, which is the flaw that invalidated the earlier version of this file.
  accessibleIds: ['gpt-5.4-mini'] as string[],
  // When true, the accessible list serves MINI with a stale admin-saved ceiling while the live catalog
  // (useModelInfo) still reports the real one.
  staleSnapshot: false,
  // What getFallbackModel returns for a deprecated model. null = no admin-configured fallback, which
  // sends the effect down the admin-default chain instead of the deprecation branch.
  fallbackModel: null as { id: string; max_tokens: number } | null,
}));

const GONE = { id: 'gpt-5.6-sol', type: 'text', contextWindow: 1_050_000, max_tokens: 128_000 };
const MINI = { id: 'gpt-5.4-mini', type: 'text', contextWindow: 400_000, max_tokens: 100_000 };

// The accessible list is `{ ...modelInfo, ...savedConfig }`, so a saved admin snapshot can disagree with
// the live catalog. This is MINI as the accessible list reports it - with a stale, much lower ceiling.
const MINI_STALE_SNAPSHOT = { ...MINI, max_tokens: 4_096 };

vi.mock('@/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { experimentalFeatures: {} }, isHydrated: true }),
}));
vi.mock('@/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false, isLoading: false }),
}));
vi.mock('../hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: [GONE, MINI] }) }));
vi.mock('../hooks/useAccessibleModels', () => ({
  useAccessibleModels: () => ({
    accessibleModels: [GONE, h.staleSnapshot ? MINI_STALE_SNAPSHOT : MINI].filter(m => h.accessibleIds.includes(m.id)),
    isModelAccessible: (id: string) => h.accessibleIds.includes(id),
    getFallbackModel: () => h.fallbackModel,
  }),
}));
vi.mock('./AdminSettingsContext', () => ({
  useAdminSettings: () => ({ getSetting: () => h.adminDefaultModel, isLoading: false }),
}));

import { LLMProvider, useLLM } from './LLMContext';

describe('LLMProvider default-model effect - the ceiling it writes for a model the user did not pick (#1254)', () => {
  beforeEach(() => {
    useLLM.getState().resetSettings();
    h.adminDefaultModel = MINI.id;
    h.accessibleIds = [MINI.id];
    h.staleSnapshot = false;
    h.fallbackModel = null;
  });
  afterEach(() => cleanup());

  it('preserves a deliberately lowered ceiling when it resolves a replacement model', async () => {
    // 2048 is the user's own setting. The effect switches the model to MINI because their model is no
    // longer accessible; without the fix it also stamps MINI's 100000 default over the 2048.
    useLLM.getState().setLLM({ model: GONE.id, max_tokens: 2048 });

    render(<LLMProvider />);

    await waitFor(() => expect(useLLM.getState().model).toBe(MINI.id));
    expect(useLLM.getState().max_tokens).toBe(2048);
    // The same branch resets the agent flags; that half is deliberate and unchanged by this fix.
    expect(useLLM.getState().isQuestMasterEnabled).toBe(false);
    expect(useLLM.getState().isAgentsEnabled).toBe(false);
  });

  it('fits against the live catalog, not a stale admin-saved snapshot of the resolved model', async () => {
    // The accessible list serves MINI with a stale 4096 ceiling while the live catalog says 100000.
    // Clamping to the snapshot would strand the user at 4096, and the sibling refit effect reads the
    // live repo, so the two paths would disagree.
    h.staleSnapshot = true;
    useLLM.getState().setLLM({ model: GONE.id, max_tokens: 50_000 });

    render(<LLMProvider />);

    await waitFor(() => expect(useLLM.getState().model).toBe(MINI.id));
    expect(useLLM.getState().max_tokens).toBe(50_000);
  });

  it('still clamps a ceiling the resolved model cannot serve down to its default', async () => {
    // 128000 came from a stronger model and exceeds MINI's 100000 ceiling, so it MUST come down.
    // This is the guard against over-fixing by preserving unconditionally.
    useLLM.getState().setLLM({ model: GONE.id, max_tokens: 128_000 });

    render(<LLMProvider />);

    await waitFor(() => expect(useLLM.getState().model).toBe(MINI.id));
    expect(useLLM.getState().max_tokens).toBe(100_000);
  });

  it('fills in the resolved model default when no ceiling is set', async () => {
    // The v4 -> v5 persist migration writes max_tokens: 0, so "unset" must resolve to a real default
    // rather than being preserved as 0.
    useLLM.getState().setLLM({ model: GONE.id, max_tokens: 0 });

    render(<LLMProvider />);

    await waitFor(() => expect(useLLM.getState().model).toBe(MINI.id));
    expect(useLLM.getState().max_tokens).toBe(100_000);
  });

  // The deprecation branch runs BEFORE the admin-default chain and resolves a model on the user's behalf
  // just the same, so it owes the same guarantees. It fires when an admin has configured a fallbackModel
  // for a model that has become inaccessible (useAccessibleModels.getFallbackModel).
  it('preserves a deliberately lowered ceiling when a deprecated model falls back to its replacement', async () => {
    h.fallbackModel = MINI;
    useLLM.getState().setLLM({ model: GONE.id, max_tokens: 2048 });

    render(<LLMProvider />);

    await waitFor(() => expect(useLLM.getState().model).toBe(MINI.id));
    // Also proves the branch records the transition as app-resolved: without that, the refit effect sees
    // a model change, sets allowRaise, and puts MINI's 100000 default back over the 2048.
    expect(useLLM.getState().max_tokens).toBe(2048);
    expect(useLLM.getState().isQuestMasterEnabled).toBe(false);
    expect(useLLM.getState().isAgentsEnabled).toBe(false);
  });

  it('fits a deprecation fallback against the live catalog, not a stale admin-saved snapshot', async () => {
    // getFallbackModel returns the accessible-list entry, which carries the frozen admin ceiling, so the
    // list must serve the same stale entry - the real hook has one source for both and cannot disagree.
    h.staleSnapshot = true;
    h.fallbackModel = MINI_STALE_SNAPSHOT;
    useLLM.getState().setLLM({ model: GONE.id, max_tokens: 50_000 });

    render(<LLMProvider />);

    await waitFor(() => expect(useLLM.getState().model).toBe(MINI.id));
    expect(useLLM.getState().max_tokens).toBe(50_000);
  });

  it('still clamps a ceiling the deprecation fallback cannot serve down to its default', async () => {
    h.fallbackModel = MINI;
    useLLM.getState().setLLM({ model: GONE.id, max_tokens: 128_000 });

    render(<LLMProvider />);

    await waitFor(() => expect(useLLM.getState().model).toBe(MINI.id));
    expect(useLLM.getState().max_tokens).toBe(100_000);
  });

  it('still raises the ceiling when the user switches to a stronger model themselves', async () => {
    // The guard that matters most: an earlier attempt at #1254 disabled raising in the refit effect
    // outright and had to be reverted, because opening a notebook pinned to a stronger model applies
    // that model with no max_tokens (useHydrateModelFromSession -> applyModelFromSession) and relies
    // on this effect fitting the ceiling upward. Only an app-resolved switch may skip the raise.
    h.accessibleIds = [GONE.id, MINI.id];
    useLLM.getState().setLLM({ model: MINI.id, max_tokens: 2048 });

    render(<LLMProvider />);
    // The model stays as the user left it, so no fallback resolution happens here.
    await waitFor(() => expect(useLLM.getState().model).toBe(MINI.id));
    expect(useLLM.getState().max_tokens).toBe(2048);

    // Now the user (or session hydration on their behalf) selects the stronger model.
    useLLM.getState().setLLM({ model: GONE.id });

    await waitFor(() => expect(useLLM.getState().max_tokens).toBe(128_000));
  });
});
