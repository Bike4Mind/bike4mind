import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { buildPromptMetaModel } from './buildPromptMetaModel';

describe('buildPromptMetaModel', () => {
  it('maps a text model to the recorded promptMeta.model fields', () => {
    const model = {
      id: 'gpt-5',
      type: 'text',
      backend: 'openai',
      contextWindow: 400000,
      max_tokens: 128000,
      can_stream: true,
      can_think: true,
      supportsVision: true,
      supportsTools: true,
      supportsImageVariation: false,
      supportsSafetyTolerance: false,
      trainingCutoff: '2024-06',
    } as unknown as ModelInfo; // unknown: only the mapped fields are read

    expect(buildPromptMetaModel(model)).toEqual({
      name: 'gpt-5',
      type: 'text',
      backend: 'openai',
      contextWindow: 400000,
      maxTokens: 128000,
      canStream: true,
      canThink: true,
      supportsVision: true,
      supportsTools: true,
      supportsImageVariation: false,
      supportsSafetyTolerance: false,
      trainingCutoff: '2024-06',
    });
  });

  it('records a type a completion cannot run as undefined', () => {
    const model = { id: 'whisper-1', type: 'speech-to-text', backend: 'openai' } as unknown as ModelInfo;

    const built = buildPromptMetaModel(model);
    expect(built.name).toBe('whisper-1');
    expect(built.type).toBeUndefined();
  });
});
