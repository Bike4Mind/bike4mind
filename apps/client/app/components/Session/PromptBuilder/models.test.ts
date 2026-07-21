import { describe, it, expect } from 'vitest';
import { isImageGenerationModel } from './models';

describe('isImageGenerationModel', () => {
  it('is true for text-to-image generation models', () => {
    expect(isImageGenerationModel('flux-pro-1.1')).toBe(true);
    expect(isImageGenerationModel('gpt-image-1')).toBe(true);
    expect(isImageGenerationModel('gemini-2.5-flash-image')).toBe(true);
  });

  it('is false for editing / inpainting models (prompts are edit instructions, not scene-building)', () => {
    expect(isImageGenerationModel('flux-kontext-pro')).toBe(false);
    expect(isImageGenerationModel('flux-kontext-max')).toBe(false);
    expect(isImageGenerationModel('flux-pro-1.0-fill')).toBe(false);
  });

  it('is false for non-image models', () => {
    expect(isImageGenerationModel('gpt-4o')).toBe(false);
  });
});
