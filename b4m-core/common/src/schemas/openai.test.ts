import { describe, it, expect } from 'vitest';
import { ImageModels } from '../models';
import {
  ChatCompletionCreateInputSchema,
  OpenAIImageGenerationInput,
  LEGACY_IMAGE_MODEL_MAP,
  resolveLegacyImageModel,
  toNonWebpOutputFormat,
} from './openai';

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

  // A retired id would otherwise pass the enum and only fail in the image worker, which no longer
  // lists it as an available model.
  it('remaps retired gpt-image-1 to gpt-image-2', () => {
    expect(OpenAIImageGenerationInput.parse({ prompt: 'x', model: ImageModels.GPT_IMAGE_1 }).model).toBe(
      ImageModels.GPT_IMAGE_2
    );
  });

  it('passes supported models through unchanged', () => {
    for (const model of [ImageModels.FLUX_PRO_1_1, ImageModels.GPT_IMAGE_1_5, ImageModels.GPT_IMAGE_2]) {
      expect(OpenAIImageGenerationInput.parse({ prompt: 'x', model }).model).toBe(model);
    }
  });

  it('still rejects genuinely unknown models', () => {
    expect(() => OpenAIImageGenerationInput.parse({ prompt: 'x', model: 'not-a-real-model' })).toThrow();
  });

  it('every legacy remap target is itself a valid, supported model', () => {
    for (const target of Object.values(LEGACY_IMAGE_MODEL_MAP)) {
      expect(() => OpenAIImageGenerationInput.parse({ prompt: 'x', model: target })).not.toThrow();
    }
  });

  // A target that is itself a key would need two hops, and every caller applies the map once.
  it('no legacy remap target is itself remapped', () => {
    for (const target of Object.values(LEGACY_IMAGE_MODEL_MAP)) {
      expect(resolveLegacyImageModel(target)).toBe(target);
    }
  });
});

describe('resolveLegacyImageModel', () => {
  it('returns the successor for a legacy id', () => {
    expect(resolveLegacyImageModel('dall-e-3')).toBe(ImageModels.GPT_IMAGE_2);
    expect(resolveLegacyImageModel(ImageModels.GPT_IMAGE_1)).toBe(ImageModels.GPT_IMAGE_2);
  });

  it('returns any other value unchanged, including non-strings and inherited keys', () => {
    expect(resolveLegacyImageModel(ImageModels.GPT_IMAGE_1_5)).toBe(ImageModels.GPT_IMAGE_1_5);
    expect(resolveLegacyImageModel('local-image/foo')).toBe('local-image/foo');
    expect(resolveLegacyImageModel('constructor')).toBe('constructor');
    expect(resolveLegacyImageModel(undefined)).toBeUndefined();
    expect(resolveLegacyImageModel(42)).toBe(42);
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

describe('OpenAIImageGenerationInput background', () => {
  it('accepts the three gpt-image alpha settings', () => {
    for (const background of ['transparent', 'opaque', 'auto'] as const) {
      expect(
        OpenAIImageGenerationInput.parse({ prompt: 'x', model: ImageModels.GPT_IMAGE_2, background }).background
      ).toBe(background);
    }
  });

  it('stays optional so existing clients that never send it still parse', () => {
    expect(
      OpenAIImageGenerationInput.parse({ prompt: 'x', model: ImageModels.GPT_IMAGE_2 }).background
    ).toBeUndefined();
  });

  it('rejects an unknown background value', () => {
    expect(() =>
      OpenAIImageGenerationInput.parse({ prompt: 'x', model: ImageModels.GPT_IMAGE_2, background: 'chroma' })
    ).toThrow();
  });
});

describe('toNonWebpOutputFormat', () => {
  it('degrades webp to png for providers that only accept png/jpeg', () => {
    expect(toNonWebpOutputFormat('webp')).toBe('png');
  });

  it('passes every other value through untouched', () => {
    expect(toNonWebpOutputFormat('png')).toBe('png');
    expect(toNonWebpOutputFormat('jpeg')).toBe('jpeg');
    expect(toNonWebpOutputFormat(null)).toBeNull();
    expect(toNonWebpOutputFormat(undefined)).toBeUndefined();
  });
});

describe('ChatCompletionCreateInputSchema thinking budget', () => {
  it('rejects a legacy thinking budget past MAX_THINKING_BUDGET_TOKENS', () => {
    const parsed = ChatCompletionCreateInputSchema.safeParse({
      model: 'claude',
      thinking: { enabled: true, budget_tokens: 10_000_000 },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a budget within the bound', () => {
    const parsed = ChatCompletionCreateInputSchema.safeParse({
      model: 'claude',
      thinking: { enabled: true, budget_tokens: 32_000 },
    });
    expect(parsed.success).toBe(true);
  });
});
