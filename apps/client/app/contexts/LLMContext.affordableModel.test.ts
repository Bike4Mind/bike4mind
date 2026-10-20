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

  it('keeps the normal switch active for a new chat and in the reload snapshot', () => {
    useLLM.getState().setLLM(buildModelSelectionPatch(affordable));

    expect(useLLM.getState()).toMatchObject({ model: affordable.id, lastUsedTextModel: affordable.id });
    const persisted = JSON.parse(localStorage.getItem('llm-settings') ?? '{}') as {
      state?: { model?: string; lastUsedTextModel?: string };
    };
    expect(persisted.state).toMatchObject({ model: affordable.id, lastUsedTextModel: affordable.id });
  });
});
