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

describe('LLMContext image-template apply + drift', () => {
  beforeEach(() => {
    useLLM.getState().resetSettings();
    useLLM.setState({ currentTemplateId: null });
  });

  it('applyImageTemplate loads model + settings and marks the template current', () => {
    useLLM.getState().applyImageTemplate(template());
    const s = useLLM.getState();
    expect(s.model).toBe('flux-pro-1.1');
    expect(s.imageModel).toBe('flux-pro-1.1');
    expect(s.quality).toBe('hd');
    expect(s.width).toBe(1024);
    expect(s.currentTemplateId).toBe('t1');
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

  it('a manual image-setting change via setLLM clears the applied-template chip', () => {
    useLLM.getState().applyImageTemplate(template());
    expect(useLLM.getState().currentTemplateId).toBe('t1');

    useLLM.getState().setLLM({ quality: 'standard' });
    expect(useLLM.getState().currentTemplateId).toBeNull();
  });

  it('a non-image setting change does NOT clear the chip', () => {
    useLLM.getState().applyImageTemplate(template());
    useLLM.getState().setLLM({ temperature: 0.5 });
    expect(useLLM.getState().currentTemplateId).toBe('t1');
  });

  it('changing the model clears the chip', () => {
    useLLM.getState().applyImageTemplate(template());
    useLLM.getState().setLLM({ model: 'gpt-image-1' });
    expect(useLLM.getState().currentTemplateId).toBeNull();
  });

  it('explicitly clearing currentTemplateId works and is not treated as drift', () => {
    useLLM.getState().applyImageTemplate(template());
    useLLM.getState().setLLM({ currentTemplateId: null });
    expect(useLLM.getState().currentTemplateId).toBeNull();
  });
});
