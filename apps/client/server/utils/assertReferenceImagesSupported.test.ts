import { describe, expect, it } from 'vitest';
import { ImageModels } from '@bike4mind/common';
import { assertReferenceImagesSupported } from './assertReferenceImagesSupported';

const ids = (count: number) => Array.from({ length: count }, (_, index) => `ref-${index}`);

describe('assertReferenceImagesSupported (edit)', () => {
  it.each([
    [ImageModels.GPT_IMAGE_2, 15],
    [ImageModels.FLUX_2_PRO, 7],
    [ImageModels.FLUX_2_KLEIN_4B, 3],
  ])('%s takes %s references and rejects one more', (model, limit) => {
    expect(() => assertReferenceImagesSupported(model, ids(limit))).not.toThrow();
    expect(() => assertReferenceImagesSupported(model, ids(limit + 1))).toThrow(`at most ${limit} images`);
  });

  it.each([ImageModels.FLUX_PRO_1_1, ImageModels.FLUX_PRO_FILL, ImageModels.GEMINI_3_PRO_IMAGE])(
    'rejects references for %s',
    model => {
      expect(() => assertReferenceImagesSupported(model, ['ref'])).toThrow('not supported');
    }
  );

  it('ignores an absent or empty list', () => {
    expect(() => assertReferenceImagesSupported(ImageModels.FLUX_PRO_FILL, undefined)).not.toThrow();
    expect(() => assertReferenceImagesSupported(ImageModels.FLUX_PRO_FILL, [])).not.toThrow();
  });

  it.each([
    [ImageModels.FLUX_2_PRO, 8],
    [ImageModels.FLUX_2_KLEIN_4B, 4],
  ])('keeps the generate limit for %s at %s', (model, limit) => {
    expect(() => assertReferenceImagesSupported(model, ids(limit), 'generate')).not.toThrow();
    expect(() => assertReferenceImagesSupported(model, ids(limit + 1), 'generate')).toThrow(`at most ${limit} images`);
  });
});

describe('assertReferenceImagesSupported (generate, FLUX 3)', () => {
  it.each([ImageModels.FLUX_3_IMAGE, ImageModels.FLUX_3_IMAGE_KLEIN])('%s takes 10 references, not 11', model => {
    expect(() => assertReferenceImagesSupported(model, ids(10), 'generate')).not.toThrow();
    expect(() => assertReferenceImagesSupported(model, ids(11), 'generate')).toThrow('at most 10 images');
  });

  it('counts the primary toward the cap', () => {
    const model = ImageModels.FLUX_3_IMAGE;
    expect(() => assertReferenceImagesSupported(model, ids(9), 'generate', ['primary'])).not.toThrow();
    expect(() => assertReferenceImagesSupported(model, ids(10), 'generate', ['primary'])).toThrow('at most 10 images');
  });

  it('counts a primary repeated in the references once', () => {
    const refs = ['primary', ...ids(9)];
    expect(() => assertReferenceImagesSupported(ImageModels.FLUX_3_IMAGE, refs, 'generate', ['primary'])).not.toThrow();
  });

  it('counts the primary for FLUX.2 too', () => {
    expect(() => assertReferenceImagesSupported(ImageModels.FLUX_2_PRO, ids(8), 'generate', ['primary'])).toThrow(
      'at most 8 images'
    );
  });

  it('does not count the primary for gpt-image, which has its own slot', () => {
    expect(() =>
      assertReferenceImagesSupported(ImageModels.GPT_IMAGE_1, ids(15), 'generate', ['primary'])
    ).not.toThrow();
  });

  it('still rejects references on FLUX 3 edit', () => {
    expect(() => assertReferenceImagesSupported(ImageModels.FLUX_3_IMAGE, ['ref'])).toThrow('not supported');
  });
});
