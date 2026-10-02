import { describe, it, expect } from 'vitest';
import { IMAGE_SIZE_CONSTRAINTS, IMAGE_MODELS, ImageModels } from '../models';
import { MAX_IMAGES_PER_REQUEST } from '../schemas/openai';
import { getImageModelCapabilities, type ImageSizing } from './imageCapabilities';
import { isSupportedImageSize } from './imageSizes';
import { MAX_REFERENCE_IMAGES } from './modelHelpers';

// A Record, so a new ImageModels member fails typecheck until its sizing is decided here.
const EXPECTED_SIZING: Record<ImageModels, ImageSizing['kind']> = {
  [ImageModels.GPT_IMAGE_1]: 'presets',
  [ImageModels.GPT_IMAGE_1_5]: 'presets',
  [ImageModels.GPT_IMAGE_1_MINI]: 'presets',
  [ImageModels.GPT_IMAGE_2]: 'constrained',
  [ImageModels.GPT_IMAGE_2_5_SUNBURST]: 'constrained',
  [ImageModels.GPT_IMAGE_2_5_FLARE]: 'constrained',
  [ImageModels.DALL_E_2]: 'presets',
  [ImageModels.FLUX_PRO]: 'dimensions',
  [ImageModels.FLUX_PRO_1_1]: 'dimensions',
  [ImageModels.FLUX_PRO_ULTRA]: 'aspectRatio',
  [ImageModels.FLUX_PRO_FILL]: 'inputImage',
  [ImageModels.FLUX_KONTEXT_PRO]: 'inputImage',
  [ImageModels.FLUX_KONTEXT_MAX]: 'inputImage',
  [ImageModels.GROK_IMAGINE_IMAGE_QUALITY]: 'fixed',
  [ImageModels.GEMINI_2_5_FLASH_IMAGE]: 'aspectRatio',
  [ImageModels.GEMINI_3_PRO_IMAGE_PREVIEW]: 'aspectRatio',
  [ImageModels.GEMINI_3_1_FLASH_IMAGE]: 'aspectRatio',
  [ImageModels.GEMINI_3_PRO_IMAGE]: 'aspectRatio',
};

const OPENAI_SIZED_MODELS = IMAGE_MODELS.filter(model => {
  const { kind } = getImageModelCapabilities(model).sizing;
  return kind === 'presets' || kind === 'constrained';
});

describe('getImageModelCapabilities', () => {
  it.each(IMAGE_MODELS)('sizes %s the way its request path does', model => {
    expect(getImageModelCapabilities(model).sizing.kind).toBe(EXPECTED_SIZING[model]);
  });

  describe('round-trips with the validators', () => {
    it.each(OPENAI_SIZED_MODELS)('every size advertised for %s is accepted by isSupportedImageSize', model => {
      const { sizing } = getImageModelCapabilities(model);
      if (sizing.kind !== 'presets' && sizing.kind !== 'constrained') throw new Error('unreachable');
      const advertised = [
        ...sizing.presets,
        sizing.defaultSize,
        ...(sizing.kind === 'constrained' ? [sizing.autoSize] : []),
      ];
      for (const size of advertised) expect(isSupportedImageSize(model, size)).toBe(true);
    });

    it('a custom gpt-image-2 size built from the advertised constraints is accepted, one past them is not', () => {
      const { sizing } = getImageModelCapabilities(ImageModels.GPT_IMAGE_2);
      if (sizing.kind !== 'constrained') throw new Error('expected constrained sizing');
      const { maxEdge, maxAspectRatio, edgeMultiple } = sizing.constraints;
      const shortEdge = maxEdge / maxAspectRatio;

      expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, `${maxEdge}x${shortEdge}`)).toBe(true);
      expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, `${maxEdge + edgeMultiple}x${shortEdge}`)).toBe(false);
    });

    it('hands out the constants themselves rather than copies', () => {
      const gptImage2 = getImageModelCapabilities(ImageModels.GPT_IMAGE_2).sizing;
      const flux = getImageModelCapabilities(ImageModels.FLUX_PRO_1_1).sizing;
      if (gptImage2.kind !== 'constrained' || flux.kind !== 'dimensions') throw new Error('unexpected sizing');

      expect(gptImage2.constraints).toBe(IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.constraints);
      expect(gptImage2.presets).toBe(IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.sizes);
      expect(flux.presets).toBe(IMAGE_SIZE_CONSTRAINTS.BFL.sizes);
    });

    // Bounds only: `step` is the custom-dimension granularity, and some presets (800x600, 1280x720)
    // predate it and are not multiples of it.
    it('every BFL preset sits inside the advertised dimension bounds', () => {
      const { sizing } = getImageModelCapabilities(ImageModels.FLUX_PRO_1_1);
      if (sizing.kind !== 'dimensions') throw new Error('expected dimension sizing');
      for (const size of sizing.presets) {
        const [width, height] = size.split('x').map(Number);
        expect(width).toBeGreaterThanOrEqual(sizing.minWidth);
        expect(width).toBeLessThanOrEqual(sizing.maxWidth);
        expect(height).toBeGreaterThanOrEqual(sizing.minHeight);
        expect(height).toBeLessThanOrEqual(sizing.maxHeight);
      }
    });
  });

  describe('gpt-image-2.5 vs gpt-image-2', () => {
    const gptImage2 = getImageModelCapabilities(ImageModels.GPT_IMAGE_2);
    const sunburst = getImageModelCapabilities(ImageModels.GPT_IMAGE_2_5_SUNBURST);

    it('share size rules', () => {
      expect(sunburst.sizing).toEqual(gptImage2.sizing);
    });

    it('differ on transparency', () => {
      expect(gptImage2.supports.transparentBackground).toBe(false);
      expect(sunburst.supports.transparentBackground).toBe(true);
    });

    it('only 2.5 offers the extended quality tiers', () => {
      expect(gptImage2.supports.qualities).toEqual(['low', 'medium', 'high', 'auto']);
      expect(sunburst.supports.qualities).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'auto']);
    });
  });

  describe('supported params', () => {
    it('gpt-image-1 takes transparency and reference images but no seed', () => {
      expect(getImageModelCapabilities(ImageModels.GPT_IMAGE_1).supports).toEqual({
        transparentBackground: true,
        seed: false,
        qualities: ['low', 'medium', 'high', 'auto'],
        maxImages: MAX_IMAGES_PER_REQUEST,
        maxReferenceImages: MAX_REFERENCE_IMAGES,
        edit: true,
        requiresInputImage: false,
      });
    });

    it('BFL honours a seed and no quality or reference images', () => {
      const { supports } = getImageModelCapabilities(ImageModels.FLUX_PRO_1_1);
      expect(supports.seed).toBe(true);
      expect(supports.qualities).toEqual([]);
      expect(supports.maxReferenceImages).toBe(0);
      expect(supports.transparentBackground).toBe(false);
    });

    it('Kontext needs an input image', () => {
      expect(getImageModelCapabilities(ImageModels.FLUX_KONTEXT_PRO).supports.requiresInputImage).toBe(true);
    });

    it('Gemini edits but takes no seed', () => {
      const { supports } = getImageModelCapabilities(ImageModels.GEMINI_3_PRO_IMAGE);
      expect(supports.edit).toBe(true);
      expect(supports.seed).toBe(false);
    });

    it('Grok takes none of the optional params', () => {
      const { supports } = getImageModelCapabilities(ImageModels.GROK_IMAGINE_IMAGE_QUALITY);
      expect(supports).toMatchObject({
        transparentBackground: false,
        seed: false,
        qualities: [],
        maxReferenceImages: 0,
        edit: false,
        requiresInputImage: false,
      });
    });
  });
});
