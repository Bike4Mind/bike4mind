import { describe, it, expect, beforeEach } from 'vitest';
import type { IImageGenerationTemplateDocument } from '@bike4mind/common';
import { useLLM } from './LLMContext';

const template = (overrides: Partial<IImageGenerationTemplateDocument> = {}): IImageGenerationTemplateDocument =>
  ({
    id: 't1',
    userId: 'u1',
    name: 'Cinematic',
    model: 'flux-pro-1.1',
    settings: { quality: 'hd', width: 1024, height: 768 },
    usageCount: 0,
    ...overrides,
  }) as IImageGenerationTemplateDocument;

describe('LLMContext applyImageTemplate', () => {
  beforeEach(() => {
    useLLM.getState().resetSettings();
  });

  it('loads the template model + settings into the store', () => {
    useLLM.getState().applyImageTemplate(template());
    const s = useLLM.getState();
    expect(s.model).toBe('flux-pro-1.1');
    expect(s.imageModel).toBe('flux-pro-1.1');
    expect(s.quality).toBe('hd');
    expect(s.width).toBe(1024);
  });

  it('resets image-setting fields the template omits, so apply reproduces the snapshot', () => {
    // User has a non-default width from prior use.
    useLLM.getState().setLLM({ width: 2048 });
    expect(useLLM.getState().width).toBe(2048);

    // Apply a PARTIAL template (only quality). width must reset to the default, not
    // inherit the stale 2048.
    useLLM.getState().applyImageTemplate(template({ settings: { quality: 'hd' } }));
    const s = useLLM.getState();
    expect(s.quality).toBe('hd');
    expect(s.width).toBe(1024); // default, not the prior 2048
  });
});
