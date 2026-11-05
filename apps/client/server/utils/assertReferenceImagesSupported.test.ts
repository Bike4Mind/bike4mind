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

  it('keeps the generate limit on getMaxReferenceImages', () => {
    expect(() => assertReferenceImagesSupported(ImageModels.FLUX_2_PRO, ids(8), 'generate')).not.toThrow();
  });
});
