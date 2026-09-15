import { describe, it, expect } from 'vitest';
import { ImageModels } from '../models';
import { OpenAIImageGenerationInput, LEGACY_IMAGE_MODEL_MAP } from './openai';

describe('OpenAIImageGenerationInput legacy model remapping', () => {
  it('remaps removed flux-dev to flux-pro-1.1 instead of throwing (regression: #8853)', () => {
    const result = OpenAIImageGenerationInput.parse({ prompt: 'a red apple', model: 'flux-dev' });
    expect(result.model).toBe(ImageModels.FLUX_PRO_1_1);
  });

  it('remaps every legacy xAI image id to grok-imagine-image-quality instead of throwing (regression: #9211)', () => {
    for (const legacy of ['grok-2-image-1212', 'grok-2-image', 'grok-2-image-gen']) {
      const result = OpenAIImageGenerationInput.parse({ prompt: 'a red apple', model: legacy });
      expect(result.model).toBe(ImageModels.GROK_IMAGINE_IMAGE_QUALITY);
    }
  });

  it('remaps legacy dall-e ids to gpt-image-2', () => {
    expect(OpenAIImageGenerationInput.parse({ prompt: 'x', model: 'dall-e-3' }).model).toBe(ImageModels.GPT_IMAGE_2);
    expect(OpenAIImageGenerationInput.parse({ prompt: 'x', model: 'dall-e-2' }).model).toBe(ImageModels.GPT_IMAGE_2);
  });

  it('passes supported models through unchanged', () => {
    expect(OpenAIImageGenerationInput.parse({ prompt: 'x', model: ImageModels.FLUX_PRO_1_1 }).model).toBe(
      ImageModels.FLUX_PRO_1_1
    );
    expect(OpenAIImageGenerationInput.parse({ prompt: 'x', model: ImageModels.GPT_IMAGE_1 }).model).toBe(
      ImageModels.GPT_IMAGE_1
    );
  });

  it('still rejects genuinely unknown models', () => {
    expect(() => OpenAIImageGenerationInput.parse({ prompt: 'x', model: 'not-a-real-model' })).toThrow();
  });

  it('every legacy remap target is itself a valid, supported model', () => {
    for (const target of Object.values(LEGACY_IMAGE_MODEL_MAP)) {
      expect(() => OpenAIImageGenerationInput.parse({ prompt: 'x', model: target })).not.toThrow();
    }
  });
});

describe('OpenAIImageGenerationInput local-image model ids', () => {
  it('accepts a plain namespaced checkpoint id', () => {
    const result = OpenAIImageGenerationInput.parse({ prompt: 'x', model: 'local-image/v1-5-pruned-emaonly' });
    expect(result.model).toBe('local-image/v1-5-pruned-emaonly');
  });

  it('accepts a checkpoint name containing spaces (e.g. "Deliberate v2")', () => {
    expect(() => OpenAIImageGenerationInput.parse({ prompt: 'x', model: 'local-image/Deliberate v2' })).not.toThrow();
  });

  it('accepts a subfoldered checkpoint name (forward slash in the suffix)', () => {
    expect(() =>
      OpenAIImageGenerationInput.parse({ prompt: 'x', model: 'local-image/anime/foo.safetensors' })
    ).not.toThrow();
  });

  it('rejects an empty suffix and non-namespaced junk', () => {
    expect(() => OpenAIImageGenerationInput.parse({ prompt: 'x', model: 'local-image/' })).toThrow();
    expect(() => OpenAIImageGenerationInput.parse({ prompt: 'x', model: 'local-image' })).toThrow();
    expect(() => OpenAIImageGenerationInput.parse({ prompt: 'x', model: 'totally-made-up' })).toThrow();
  });

  it('rejects a whitespace-only suffix (no non-whitespace checkpoint name)', () => {
    expect(() => OpenAIImageGenerationInput.parse({ prompt: 'x', model: 'local-image/   ' })).toThrow();
    expect(() => OpenAIImageGenerationInput.parse({ prompt: 'x', model: 'local-image/ ' })).toThrow();
  });
});
