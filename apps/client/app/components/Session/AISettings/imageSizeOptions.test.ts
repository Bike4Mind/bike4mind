import { describe, it, expect } from 'vitest';
import { GEMINI_IMAGE_MODELS, IMAGE_MODELS, IMAGE_SIZE_CONSTRAINTS, ImageModels } from '@bike4mind/common';
import { defaultImageSize, getAvailableImageSizes, getImageSizePresets, showsImageSizeRow } from './imageSizeOptions';

const { GPT_IMAGE_1, GPT_IMAGE_2, BFL, DALL_E_2 } = IMAGE_SIZE_CONSTRAINTS;

// The models whose picked size reaches the render, and the presets and default each showed before
// the picker moved onto getImageModelCapabilities. dall-e-2 is the one row that changed: it used
// to get the BFL list.
const SIZED: readonly [string, readonly string[], string][] = [
  [ImageModels.GPT_IMAGE_1, GPT_IMAGE_1.sizes, GPT_IMAGE_1.defaultSize],
  [ImageModels.GPT_IMAGE_1_5, GPT_IMAGE_1.sizes, GPT_IMAGE_1.defaultSize],
  [ImageModels.GPT_IMAGE_1_MINI, GPT_IMAGE_1.sizes, GPT_IMAGE_1.defaultSize],
  [ImageModels.GPT_IMAGE_2, GPT_IMAGE_2.sizes, GPT_IMAGE_2.defaultSize],
  [ImageModels.GPT_IMAGE_2_5_SUNBURST, GPT_IMAGE_2.sizes, GPT_IMAGE_2.defaultSize],
  [ImageModels.GPT_IMAGE_2_5_FLARE, GPT_IMAGE_2.sizes, GPT_IMAGE_2.defaultSize],
  [ImageModels.FLUX_PRO, BFL.sizes, BFL.defaultSize],
  [ImageModels.FLUX_PRO_1_1, BFL.sizes, BFL.defaultSize],
  [ImageModels.DALL_E_2, DALL_E_2.sizes, DALL_E_2.defaultSize],
];

// The models whose sizing takes no size: aspectRatio (Ultra, Gemini), inputImage (Fill, Kontext),
// fixed (Grok).
const UNSIZED: readonly string[] = [
  ImageModels.FLUX_PRO_ULTRA,
  ImageModels.FLUX_PRO_FILL,
  ImageModels.FLUX_KONTEXT_PRO,
  ImageModels.FLUX_KONTEXT_MAX,
  ImageModels.GROK_IMAGINE_IMAGE_QUALITY,
  ...GEMINI_IMAGE_MODELS,
];

describe('showsImageSizeRow', () => {
  it('has every catalog image model sorted into exactly one of the two lists', () => {
    // A new image model fails here until someone decides whether its row shows.
    expect([...SIZED.map(([model]) => model), ...UNSIZED].sort()).toEqual([...IMAGE_MODELS].sort());
  });

  it.each(SIZED.map(([model]) => model))('shows the row for %s', model => {
    expect(showsImageSizeRow(model)).toBe(true);
  });

  it.each(UNSIZED)('hides the row for %s, which takes no size', model => {
    expect(showsImageSizeRow(model)).toBe(false);
  });

  it('keeps the row for an unrecognized model', () => {
    expect(showsImageSizeRow('some-unreleased-model')).toBe(true);
    expect(showsImageSizeRow(undefined)).toBe(true);
  });
});

describe('getImageSizePresets', () => {
  it.each(SIZED)('lists %s its own presets', (model, presets) => {
    expect(getImageSizePresets(model)).toEqual(presets);
  });

  it.each(UNSIZED)('offers no preset for %s', model => {
    expect(getImageSizePresets(model)).toEqual([]);
  });

  it('reads a dated gpt-image snapshot as its family', () => {
    expect(getImageSizePresets('gpt-image-2-2026-01-15')).toEqual(GPT_IMAGE_2.sizes);
    expect(getImageSizePresets('gpt-image-1-2025-04-23')).toEqual(GPT_IMAGE_1.sizes);
  });

  it('falls back to the BFL presets for an unrecognized model', () => {
    expect(getImageSizePresets('some-unreleased-model')).toEqual(BFL.sizes);
    expect(getImageSizePresets(undefined)).toEqual(BFL.sizes);
  });
});

describe('getAvailableImageSizes', () => {
  it('surfaces a custom size gpt-image-2 supports but does not list', () => {
    // The BFL default. gpt-image-2 accepts it, so a model switch keeps it - and it has to stay
    // visible or the Select renders blank and hides what is about to be generated.
    expect(getAvailableImageSizes(ImageModels.GPT_IMAGE_2, '1280x960')).toContain('1280x960');
    expect(getAvailableImageSizes(ImageModels.GPT_IMAGE_2, 'auto')).toContain('auto');
  });

  it('does not duplicate a size that is already a preset', () => {
    const sizes = getAvailableImageSizes(ImageModels.GPT_IMAGE_2, '2048x2048');
    expect(sizes).toEqual(IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.sizes);
  });

  it('does not offer a size the model rejects', () => {
    // 810 is not a multiple of 16, so gpt-image-2 will not take it.
    expect(getAvailableImageSizes(ImageModels.GPT_IMAGE_2, '1440x810')).toEqual(
      IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.sizes
    );
    // The gpt-image-1 family has three fixed sizes and no custom resolutions at all.
    expect(getAvailableImageSizes(ImageModels.GPT_IMAGE_1_5, '1280x960')).toEqual(
      IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.sizes
    );
  });

  it('leaves non-OpenAI models on their presets alone', () => {
    // isSupportedImageSize measures OpenAI tiers only, so a BFL size must never be put through it.
    expect(getAvailableImageSizes(ImageModels.FLUX_PRO_1_1, '2048x2048')).toEqual(IMAGE_SIZE_CONSTRAINTS.BFL.sizes);
    // A dall-e size, which isSupportedImageSize does accept for a model outside the OpenAI tiers.
    expect(getAvailableImageSizes(ImageModels.FLUX_PRO_1_1, '256x256')).toEqual(IMAGE_SIZE_CONSTRAINTS.BFL.sizes);
  });

  it('never adds a size to dall-e-2, whose presets are the whole list', () => {
    expect(getAvailableImageSizes(ImageModels.DALL_E_2, '1280x960')).toEqual(IMAGE_SIZE_CONSTRAINTS.DALL_E_2.sizes);
  });

  it('returns the presets unchanged when no size is set', () => {
    expect(getAvailableImageSizes(ImageModels.GPT_IMAGE_2, undefined)).toEqual(
      IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.sizes
    );
  });
});

describe('defaultImageSize', () => {
  it.each(SIZED)('defaults %s to its own size', (model, _presets, defaultSize) => {
    expect(defaultImageSize(model)).toBe(defaultSize);
  });

  it('falls back to the GPT-Image-1 default for an unrecognized model', () => {
    expect(defaultImageSize('some-unreleased-model')).toBe(IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.defaultSize);
  });
});

describe('the Select value is always one of its options', () => {
  // The defect this module exists to prevent: Joy draws a Select blank when its value matches no
  // <Option>, so both modals depend on `value` and `options` never disagreeing. Asserting the
  // invariant directly is what a per-field state check missed.
  // UNSIZED models are left out: both modals hide the row, so nothing is drawn for them.
  const models = [...SIZED.map(([model]) => model), 'some-unreleased-model'];
  const sizes = [undefined, 'auto', '1024x1024', '1280x960', '2048x2048', '1440x810', '1536x1024', '256x256'];

  it.each(models)('holds for %s', model => {
    for (const size of sizes) {
      const value = size || defaultImageSize(model);
      const options = getAvailableImageSizes(model, size);
      if (options.includes(value)) continue;
      // A size the model rejects is discarded elsewhere (handleModelChange coerces it); what must
      // never happen is the model's own default going unrendered.
      expect(options).toContain(defaultImageSize(model));
    }
  });
});
