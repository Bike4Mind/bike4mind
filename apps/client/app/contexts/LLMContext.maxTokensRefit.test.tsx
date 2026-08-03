import { render, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #1254 regression: exercise the default-model effect in LLMProvider directly - the branch this
// PR added (`if (modelToUse.id === state.model)`), which the pure aiSettingsUtils tests cannot
// reach. Mutable holders drive the two hooks whose values decide the branch; the rest are stubbed.
const h = vi.hoisted(() => ({
  accessible: null as unknown as {
    accessibleModels: Array<{ id: string; type: string }>;
    isModelAccessible: (id: string) => boolean;
    getFallbackModel: (id: string) => unknown;
  },
  adminDefaultModel: 'gpt-5.6-sol',
}));

const SOL = { id: 'gpt-5.6-sol', type: 'text', contextWindow: 1_050_000, max_tokens: 128000 };
const MINI = { id: 'gpt-5.4-mini', type: 'text', contextWindow: 400_000, max_tokens: 100_000 };

vi.mock('@/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { experimentalFeatures: {} } }),
}));
vi.mock('@/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false, isLoading: false }),
}));
vi.mock('../hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: [SOL, MINI] }) }));
vi.mock('../hooks/useAccessibleModels', () => ({ useAccessibleModels: () => h.accessible }));
vi.mock('./AdminSettingsContext', () => ({
  useAdminSettings: () => ({ getSetting: () => h.adminDefaultModel, isLoading: false }),
}));

import { LLMProvider, useLLM } from './LLMContext';

describe('LLMProvider default-model effect - max_tokens on a same-model re-resolve (#1254)', () => {
  beforeEach(() => {
    useLLM.getState().resetSettings();
    // User is on Sol with a deliberately-lowered ceiling.
    useLLM.getState().setLLM({ model: SOL.id, max_tokens: 2048, lastUsedTextModel: SOL.id });
  });
  afterEach(() => cleanup());

  it('preserves a user-lowered ceiling when a transient accessibility blip re-resolves to the same model', async () => {
    // Sol reads inaccessible for one render (the catalog-refetch race), but the fallback chain
    // still resolves back to Sol - the exact #1254 false alarm. Without the fix this rewrites
    // max_tokens to Sol's 128000 default; with it, 2048 is preserved.
    h.adminDefaultModel = SOL.id;
    h.accessible = {
      accessibleModels: [SOL, MINI],
      isModelAccessible: (id: string) => id !== SOL.id,
      getFallbackModel: () => null,
    };

    render(<LLMProvider />);

    await waitFor(() => expect(useLLM.getState().model).toBe(SOL.id));
    expect(useLLM.getState().max_tokens).toBe(2048);
  });

  it('still resets to the new model default when the chain resolves to a different model (a real switch)', async () => {
    // Same blip, but the admin default is a different accessible model, so this is a genuine
    // switch - max_tokens must become the new model's default, not stay at the old ceiling.
    h.adminDefaultModel = MINI.id;
    h.accessible = {
      accessibleModels: [SOL, MINI],
      isModelAccessible: (id: string) => id !== SOL.id,
      getFallbackModel: () => null,
    };

    render(<LLMProvider />);

    await waitFor(() => expect(useLLM.getState().model).toBe(MINI.id));
    expect(useLLM.getState().max_tokens).toBe(100_000);
  });
});
