import { describe, it, expect } from 'vitest';
import { ImageModels } from '../models';
import { OPENAI_GPT_IMAGE_1_IMAGE_SIZES, OPENAI_GPT_IMAGE_2_IMAGE_SIZES } from '../schemas/openai';
import {
  fallbackImageSize,
  isSupportedImageSize,
  OPENAI_LEGACY_IMAGE_SIZES,
  resolveGptImageGenerateSize,
} from './imageSizes';

describe('isSupportedImageSize', () => {
  // The expected lists below are spelled out rather than derived from IMAGE_SIZE_CONSTRAINTS.
  // isSupportedImageSize reads that same table, so a derived expectation moves together with a
  // bad edit to it instead of catching one. Pinning the list literally is what lets these fail.
  it('accepts the gpt-image-1 family presets', () => {
    expect([...OPENAI_GPT_IMAGE_1_IMAGE_SIZES]).toEqual(['1024x1024', '1024x1536', '1536x1024']);
    for (const size of OPENAI_GPT_IMAGE_1_IMAGE_SIZES) {
      expect(isSupportedImageSize(ImageModels.GPT_IMAGE_1_5, size)).toBe(true);
    }
  });

  it('rejects a dall-e-2 size for the gpt-image-1 family', () => {
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_1_5, '512x512')).toBe(false);
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_1, '256x256')).toBe(false);
  });

  it('rejects a custom resolution for the gpt-image-1 family, which has fixed sizes', () => {
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_1_5, '1920x1088')).toBe(false);
  });

  it('accepts every gpt-image-2 preset, including auto', () => {
    expect([...OPENAI_GPT_IMAGE_2_IMAGE_SIZES]).toEqual([
      '1024x1024',
      '1536x1024',
      '1024x1536',
      '2048x2048',
      '2048x1152',
      '3840x2160',
      '2160x3840',
      'auto',
    ]);
    for (const size of OPENAI_GPT_IMAGE_2_IMAGE_SIZES) {
      expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, size)).toBe(true);
    }
  });

  it('accepts a custom gpt-image-2 resolution that meets every constraint', () => {
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, '1920x1088')).toBe(true);
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, '1280x1024')).toBe(true);
  });

  it('rejects a custom gpt-image-2 resolution for each individual constraint', () => {
    // Each of these violates exactly one rule from IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, '1920x1080')).toBe(false); // 1080 is not a multiple of 16
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, '800x800')).toBe(false); // under the minimum pixel count
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, '3840x2224')).toBe(false); // over the maximum pixel count
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, '3072x768')).toBe(false); // aspect ratio beyond 3:1
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, '3856x2144')).toBe(false); // long edge beyond 3840
  });

  it('rejects a size that is absent or not a WIDTHxHEIGHT pair', () => {
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, undefined)).toBe(false);
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, null)).toBe(false);
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, 'wide')).toBe(false);
  });

  it('rejects a value that only looks like a resolution', () => {
    // The pattern is anchored: extra segments and surrounding whitespace are not resolutions,
    // so they must not be measured against the constraints as if they were.
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, '1024x1024x1024')).toBe(false);
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, ' 1280x960')).toBe(false);
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, '1280x960 ')).toBe(false);
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, '1280 x 960')).toBe(false);
  });

  it('rejects a resolution with a zero edge', () => {
    // Parsed as a pair, then dropped for having no area - not measured against the constraints.
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, '0x0')).toBe(false);
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, '1024x0')).toBe(false);
    expect(isSupportedImageSize(ImageModels.GPT_IMAGE_2, '0x1024')).toBe(false);
  });

  it('measures a non-GPT-Image model against the legacy dall-e list', () => {
    // 1024x1024 appears twice: the list concatenates both dall-e tiers, which overlap on it.
    expect([...OPENAI_LEGACY_IMAGE_SIZES]).toEqual([
      '256x256',
      '512x512',
      '1024x1024',
      '1024x1024',
      '1792x1024',
      '1024x1792',
    ]);
    for (const size of OPENAI_LEGACY_IMAGE_SIZES) {
      expect(isSupportedImageSize(ImageModels.DALL_E_2, size)).toBe(true);
    }
    expect(isSupportedImageSize(ImageModels.DALL_E_2, '1024x1536')).toBe(false);
  });
});

describe('fallbackImageSize', () => {
  it('returns the tier default for each OpenAI image family', () => {
    expect(fallbackImageSize(ImageModels.GPT_IMAGE_2)).toBe('1024x1024');
    expect(fallbackImageSize(ImageModels.GPT_IMAGE_1_5)).toBe('1024x1024');
    expect(fallbackImageSize(ImageModels.DALL_E_2)).toBe('1024x1024');
  });

  it('always returns a size its own model actually supports', () => {
    for (const model of [ImageModels.GPT_IMAGE_2, ImageModels.GPT_IMAGE_1_5, ImageModels.DALL_E_2]) {
      expect(isSupportedImageSize(model, fallbackImageSize(model))).toBe(true);
    }
  });
});

describe('resolveGptImageGenerateSize', () => {
  it("defaults gpt-image-2 to 'auto' and the gpt-image-1 family to its fixed default", () => {
    expect(resolveGptImageGenerateSize(ImageModels.GPT_IMAGE_2, undefined)).toBe('auto');
    expect(resolveGptImageGenerateSize(ImageModels.GPT_IMAGE_1_5, undefined)).toBe('1024x1024');
  });

  it('keeps a supported size untouched', () => {
    expect(resolveGptImageGenerateSize(ImageModels.GPT_IMAGE_2, '1920x1088')).toBe('1920x1088');
    expect(resolveGptImageGenerateSize(ImageModels.GPT_IMAGE_1_5, '1536x1024')).toBe('1536x1024');
  });

  it('falls back when the size names a resolution the tier rejects', () => {
    expect(resolveGptImageGenerateSize(ImageModels.GPT_IMAGE_2, '1920x1080')).toBe('1024x1024');
    expect(resolveGptImageGenerateSize(ImageModels.GPT_IMAGE_1_5, '512x512')).toBe('1024x1024');
  });

  it('forwards a gpt-image-2 value that names no resolution, but coerces it for gpt-image-1', () => {
    // gpt-image-2 sizing is open-ended, so an unrecognised token is OpenAI's to interpret.
    expect(resolveGptImageGenerateSize(ImageModels.GPT_IMAGE_2, 'wide')).toBe('wide');
    expect(resolveGptImageGenerateSize(ImageModels.GPT_IMAGE_1_5, 'wide')).toBe('1024x1024');
    // A malformed pair names no resolution either, so it takes the same route.
    expect(resolveGptImageGenerateSize(ImageModels.GPT_IMAGE_2, '1024x1024x1024')).toBe('1024x1024x1024');
    expect(resolveGptImageGenerateSize(ImageModels.GPT_IMAGE_1_5, '1024x1024x1024')).toBe('1024x1024');
  });
});
