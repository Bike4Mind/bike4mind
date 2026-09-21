import { render, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageModels } from '@bike4mind/common';

// The default image model is resolved from the accessible catalog, and that catalog only lists
// backends the deployment holds a credential for. A keyless provider therefore must never win the
// default: doing so sent the user's first generation to a provider that answers 403.
//
// Fixture contract (same as LLMContext.staleModelPin.test.tsx): `accessibleModels` and
// `isModelAccessible` must agree, because the real hook builds the list BY that predicate.
const h = vi.hoisted(() => ({
  accessibleIds: [] as string[],
}));

const TEXT = { id: 'gpt-5.4-mini', type: 'text', contextWindow: 400_000, max_tokens: 100_000 };
// A checkpoint discovered from a local Stable-Diffusion server: a real image model with no
// entry in the ImageModels enum, which is why the resolver ranges over the catalog.
const LOCAL_CHECKPOINT = 'local-image/sd-xl-base';
const ALL = [
  TEXT,
  { id: ImageModels.FLUX_PRO_ULTRA, type: 'image', rank: 5 },
  { id: ImageModels.FLUX_KONTEXT_PRO, type: 'image', rank: 1 },
  { id: ImageModels.GPT_IMAGE_1, type: 'image', rank: 10 },
  { id: ImageModels.GPT_IMAGE_2, type: 'image', rank: 8 },
  { id: ImageModels.GPT_IMAGE_1_MINI, type: 'image', rank: 11 },
  { id: ImageModels.GEMINI_2_5_FLASH_IMAGE, type: 'image', rank: 7 },
  { id: LOCAL_CHECKPOINT, type: 'image' },
];

vi.mock('@/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { experimentalFeatures: {} }, isHydrated: true }),
}));
vi.mock('@/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false, isLoading: false }),
}));

// Stable references per id set, so a re-render does not re-fire the effect for the wrong reason.
const stableList = (() => {
  const cache = new Map<string, typeof ALL>();
  return (ids: string[]) => {
    const key = ids.join(',');
    const hit = cache.get(key);
    if (hit) return hit;
    const built = ALL.filter(m => ids.includes(m.id as string));
    cache.set(key, built);
    return built;
  };
})();

vi.mock('../hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: stableList(h.accessibleIds) }),
}));
vi.mock('../hooks/useAccessibleModels', () => ({
  useAccessibleModels: () => ({
    accessibleModels: stableList(h.accessibleIds),
    isModelAccessible: (id: string) => h.accessibleIds.includes(id),
    getFallbackModel: () => null,
  }),
}));
vi.mock('./AdminSettingsContext', () => ({
  useAdminSettings: () => ({ getSetting: () => TEXT.id, isLoading: false }),
}));

import { LLMProvider, useLLM } from './LLMContext';

describe('LLMProvider default image model', () => {
  beforeEach(() => {
    useLLM.getState().resetSettings();
  });
  afterEach(() => cleanup());

  it('keeps the FLUX preference when the deployment holds a BFL key', async () => {
    h.accessibleIds = [TEXT.id, ImageModels.FLUX_PRO_ULTRA, ImageModels.GPT_IMAGE_1_MINI];
    render(<LLMProvider />);
    await waitFor(() => expect(useLLM.getState().imageModel).toBe(ImageModels.FLUX_PRO_ULTRA));
  });

  it('replaces the FLUX default when the catalog lists no BFL model', async () => {
    // The self-host case: ANTHROPIC + OPENAI keys, no BFL key, so the picker has no FLUX entry
    // and the store's FLUX_PRO_ULTRA default has to be resolved away before the first send.
    h.accessibleIds = [TEXT.id, ImageModels.GPT_IMAGE_1_MINI];
    render(<LLMProvider />);
    await waitFor(() => expect(useLLM.getState().imageModel).toBe(ImageModels.GPT_IMAGE_1_MINI));
  });

  it('never defaults to a model that mandates an input image', async () => {
    // Kontext is a transform, not a text-to-image model; picking it as the default makes
    // /gen_image fail on a missing source image - even though its rank is the best here.
    h.accessibleIds = [TEXT.id, ImageModels.FLUX_KONTEXT_PRO, ImageModels.GEMINI_2_5_FLASH_IMAGE];
    render(<LLMProvider />);
    await waitFor(() => expect(useLLM.getState().imageModel).toBe(ImageModels.GEMINI_2_5_FLASH_IMAGE));
  });

  it('falls back by catalog rank, not by enum position', async () => {
    // gpt-image-1 comes first in the ImageModels enum but ranks worst of the three.
    h.accessibleIds = [TEXT.id, ImageModels.GPT_IMAGE_1, ImageModels.GPT_IMAGE_2, ImageModels.GPT_IMAGE_1_MINI];
    render(<LLMProvider />);
    await waitFor(() => expect(useLLM.getState().imageModel).toBe(ImageModels.GPT_IMAGE_2));
  });

  it('resolves a local-image checkpoint, which the ImageModels enum does not list', async () => {
    // The keyless self-host image path (IMAGE_GEN_BASE_URL). Ranging over the enum left this
    // deployment with no candidate and stranded it on the unreachable FLUX store default.
    h.accessibleIds = [TEXT.id, LOCAL_CHECKPOINT];
    render(<LLMProvider />);
    await waitFor(() => expect(useLLM.getState().imageModel).toBe(LOCAL_CHECKPOINT));
  });
});
