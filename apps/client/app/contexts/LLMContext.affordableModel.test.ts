import { beforeEach, describe, expect, it } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { buildModelSelectionPatch } from '@client/app/utils/aiSettingsUtils';
import { useLLM } from './LLMContext';

const affordable = {
  id: 'affordable',
  name: 'Affordable',
  type: 'text',
  contextWindow: 128_000,
  max_tokens: 16_384,
} as ModelInfo;

describe('affordable model persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    useLLM.getState().resetSettings();
  });

  it('restores the normal model switch after a reload', async () => {
    useLLM.getState().setLLM(buildModelSelectionPatch(affordable));

    expect(useLLM.getState()).toMatchObject({ model: affordable.id, lastUsedTextModel: affordable.id });
    const persisted = JSON.parse(localStorage.getItem('llm-settings') ?? '{}') as {
      state?: { model?: string; lastUsedTextModel?: string };
    };
    expect(persisted.state).toMatchObject({ model: affordable.id, lastUsedTextModel: affordable.id });

    const snapshot = localStorage.getItem('llm-settings');
    expect(snapshot).not.toBeNull();
    useLLM.getState().resetSettings();
    localStorage.setItem('llm-settings', snapshot!);
    await useLLM.persist.rehydrate();
    expect(useLLM.getState()).toMatchObject({ model: affordable.id, lastUsedTextModel: affordable.id });
  });
});
