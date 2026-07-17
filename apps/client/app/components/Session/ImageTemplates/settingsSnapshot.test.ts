import { describe, it, expect } from 'vitest';
import { imageTemplateSettingsSnapshot, findMatchingTemplate } from './settingsSnapshot';

// LLMContext always carries BFL-only fields with defaults (width:1024, height:768,
// prompt_upsampling:false) even on a GPT model. The snapshot must be model-aware
// and drop them for GPT, or a GPT template (which omits them) never matches -
// regression for the applied-indicator not lighting up (reported in preview env).
const gptImageState = {
  size: '1024x1024',
  quality: 'standard',
  style: 'natural',
  seed: null,
  n: 1,
  width: 1024,
  height: 768,
  aspect_ratio: '1:1',
  output_format: 'jpeg',
  safety_tolerance: undefined,
  prompt_upsampling: false,
} as any;

describe('imageTemplateSettingsSnapshot (model-aware)', () => {
  it('omits BFL-only fields for a GPT model, keeps GPT-applicable ones', () => {
    const snap = imageTemplateSettingsSnapshot('gpt-image-1-mini', gptImageState);
    expect(snap.width).toBeUndefined();
    expect(snap.height).toBeUndefined();
    expect(snap.prompt_upsampling).toBeUndefined();
    expect(snap.safety_tolerance).toBeUndefined();
    expect(snap.size).toBe('1024x1024');
    expect(snap.style).toBe('natural');
    expect(snap.output_format).toBe('jpeg');
  });

  it('includes BFL-only fields for a Flux model and drops style', () => {
    const snap = imageTemplateSettingsSnapshot('flux-pro-1.1', { ...gptImageState, width: 512, height: 512 });
    expect(snap.width).toBe(512);
    expect(snap.height).toBe(512);
    expect(snap.style).toBeUndefined();
  });
});

describe('findMatchingTemplate', () => {
  it('matches a GPT template that omits BFL fields (the reported indicator bug)', () => {
    // Exactly the shape stored for a saved GPT template.
    const template = {
      id: 't1',
      userId: 'u1',
      name: 'standard square',
      model: 'gpt-image-1-mini',
      settings: {
        size: '1024x1024',
        quality: 'standard',
        style: 'natural',
        n: 1,
        aspect_ratio: '1:1',
        output_format: 'jpeg',
      },
      usageCount: 0,
    } as any;
    const snap = imageTemplateSettingsSnapshot('gpt-image-1-mini', gptImageState);
    expect(findMatchingTemplate([template], 'gpt-image-1-mini', snap)?.id).toBe('t1');
  });
});
