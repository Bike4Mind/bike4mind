import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageModels } from '@bike4mind/common';

vi.mock('@/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { experimentalFeatures: {} }, isHydrated: true }),
}));
vi.mock('@/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false, isLoading: false }),
}));
vi.mock('../hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [] }),
}));
vi.mock('../hooks/useAccessibleModels', () => ({
  useAccessibleModels: () => ({ accessibleModels: [], isModelAccessible: () => false, getFallbackModel: () => null }),
}));
vi.mock('./AdminSettingsContext', () => ({
  useAdminSettings: () => ({ getSetting: () => undefined, isLoading: true, authedSettingsLoaded: false, error: null }),
}));

import { useLLM } from './LLMContext';

// A browser that last saved its settings before gpt-image-1 was retired still holds it; the
// worker no longer lists it as an available model, so the store must hand out its successor.
describe('llm-settings v7 -> v8 migration (retired gpt-image-1)', () => {
  const rehydrateFrom = async (persisted: Record<string, unknown>, version: number) => {
    localStorage.setItem('llm-settings', JSON.stringify({ state: persisted, version }));
    await useLLM.persist.rehydrate();
  };
  afterEach(() => localStorage.removeItem('llm-settings'));

  it('remaps a persisted gpt-image-1 in every model slot to gpt-image-2', async () => {
    await rehydrateFrom(
      {
        model: ImageModels.GPT_IMAGE_1,
        imageModel: ImageModels.GPT_IMAGE_1,
        lastUsedImageModel: ImageModels.GPT_IMAGE_1,
      },
      7
    );

    const { model, imageModel, lastUsedImageModel } = useLLM.getState();
    expect({ model, imageModel, lastUsedImageModel }).toEqual({
      model: ImageModels.GPT_IMAGE_2,
      imageModel: ImageModels.GPT_IMAGE_2,
      lastUsedImageModel: ImageModels.GPT_IMAGE_2,
    });
  });

  it('leaves a current model and a text model untouched', async () => {
    await rehydrateFrom({ model: 'claude-opus-x', imageModel: ImageModels.GPT_IMAGE_1_5 }, 7);

    expect(useLLM.getState().model).toBe('claude-opus-x');
    expect(useLLM.getState().imageModel).toBe(ImageModels.GPT_IMAGE_1_5);
  });
});
