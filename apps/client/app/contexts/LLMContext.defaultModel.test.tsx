import { render, waitFor, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The composer's model chip must show the account's real default from the start: no pick from the
// public CDN settings before the authenticated fetch, no catalog-order pick of the priciest model,
// and no silent swap later. Same fixture contract as LLMContext.staleModelPin.test.tsx:
// `accessibleModels` stays consistent with `isModelAccessible`.
const h = vi.hoisted(() => ({
  adminDefaultModel: 'mid-model',
  authedSettingsLoaded: true,
  entitlementsLoading: false,
  accessibleIds: [] as string[],
  fallbacks: {} as Record<string, string>,
  toastInfo: vi.fn(),
}));

const PRICEY = { id: 'pricey-model', name: 'Pricey', type: 'text', contextWindow: 200_000, max_tokens: 32_000 };
const MID = { id: 'mid-model', name: 'Mid', type: 'text', contextWindow: 200_000, max_tokens: 32_000 };
const CHEAP = { id: 'cheap-model', name: 'Cheap', type: 'text', contextWindow: 128_000, max_tokens: 16_000 };
const PAINT = { id: 'paint-model', name: 'Paint', type: 'image', contextWindow: 0, max_tokens: 0 };
const ALL = [PAINT, PRICEY, MID, CHEAP];

vi.mock('sonner', () => ({ toast: { info: h.toastInfo } }));
vi.mock('@/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { experimentalFeatures: {} }, isHydrated: true }),
}));
vi.mock('@/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false, isLoading: false }),
}));
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
  useModelInfo: () => ({ data: ALL }),
}));
vi.mock('../hooks/useAccessibleModels', () => ({
  useAccessibleModels: () => ({
    accessibleModels: stableList(h.accessibleIds),
    isModelAccessible: (id: string) => h.accessibleIds.includes(id),
    getFallbackModel: (id: string) => {
      const target = h.fallbacks[id];
      return target && h.accessibleIds.includes(target) ? ALL.find(m => m.id === target) : null;
    },
    isEntitlementsLoading: h.entitlementsLoading,
  }),
}));
vi.mock('./AdminSettingsContext', () => ({
  useAdminSettings: () => ({
    getSetting: () => h.adminDefaultModel,
    isLoading: false,
    authedSettingsLoaded: h.authedSettingsLoaded,
    error: null,
  }),
}));

import { LLMProvider, useLLM } from './LLMContext';

describe('LLMProvider default text model', () => {
  beforeEach(() => {
    useLLM.getState().resetSettings();
    h.adminDefaultModel = MID.id;
    h.authedSettingsLoaded = true;
    h.entitlementsLoading = false;
    h.accessibleIds = ALL.map(m => m.id);
    h.fallbacks = {};
    h.toastInfo.mockClear();
  });
  afterEach(() => cleanup());

  it('waits for the authenticated settings instead of resolving from the public artifact', async () => {
    h.authedSettingsLoaded = false;
    const { rerender } = render(<LLMProvider />);
    await act(async () => {});
    expect(useLLM.getState().model).toBe('');

    h.authedSettingsLoaded = true;
    rerender(<LLMProvider />);
    await waitFor(() => expect(useLLM.getState().model).toBe(MID.id));
  });

  it("uses the admin default's configured fallback, not the catalog's first (priciest) model", async () => {
    h.adminDefaultModel = 'unavailable-model';
    h.accessibleIds = [PAINT.id, PRICEY.id, CHEAP.id];
    h.fallbacks = { 'unavailable-model': CHEAP.id };
    render(<LLMProvider />);
    await waitFor(() => expect(useLLM.getState().model).toBe(CHEAP.id));
  });

  // Locked models never reach useModelInfo / useAccessibleModels, which is what keeps them unresolvable.
  it('never lands on a locked (paid-only) model, even when the admin default is one', async () => {
    h.adminDefaultModel = PRICEY.id;
    h.accessibleIds = [PAINT.id, CHEAP.id];
    useLLM.setState({ lastUsedTextModel: MID.id });
    render(<LLMProvider />);
    await waitFor(() => expect(useLLM.getState().model).toBe(CHEAP.id));
  });

  it('skips a leading image model when nothing better is configured', async () => {
    h.adminDefaultModel = 'unavailable-model';
    h.accessibleIds = [PAINT.id, MID.id];
    render(<LLMProvider />);
    await waitFor(() => expect(useLLM.getState().model).toBe(MID.id));
  });

  it('does not toast the first resolution of a fresh store', async () => {
    render(<LLMProvider />);
    await waitFor(() => expect(useLLM.getState().model).toBe(MID.id));
    expect(h.toastInfo).not.toHaveBeenCalled();
  });

  it('tells the user when a model they were on is replaced', async () => {
    render(<LLMProvider />);
    await waitFor(() => expect(useLLM.getState().model).toBe(MID.id));

    act(() => {
      useLLM.getState().setLLM({ model: PRICEY.id });
    });
    h.accessibleIds = [MID.id, CHEAP.id];
    act(() => {
      useLLM.getState().setLLM({ model: 'gone-model' });
    });

    await waitFor(() => expect(useLLM.getState().model).toBe(MID.id));
    expect(h.toastInfo).toHaveBeenCalledWith(
      "gone-model isn't available on your account, so new messages use Mid.",
      expect.objectContaining({ id: 'llm-model-replaced' })
    );
  });

  it('keeps a persisted model that is only missing because entitlements have not loaded yet', async () => {
    useLLM.setState({ model: CHEAP.id });
    h.entitlementsLoading = true;
    h.accessibleIds = [PAINT.id, MID.id];
    const { rerender } = render(<LLMProvider />);
    await act(async () => {});
    expect(useLLM.getState().model).toBe(CHEAP.id);

    h.entitlementsLoading = false;
    h.accessibleIds = ALL.map(m => m.id);
    rerender(<LLMProvider />);
    await act(async () => {});
    expect(useLLM.getState().model).toBe(CHEAP.id);
    expect(h.toastInfo).not.toHaveBeenCalled();
  });
});
