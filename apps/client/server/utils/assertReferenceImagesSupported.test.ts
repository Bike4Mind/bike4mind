import { describe, expect, it } from 'vitest';
import { ImageModels } from '@bike4mind/common';
import { assertReferenceImagesSupported } from './assertReferenceImagesSupported';

describe('assertReferenceImagesSupported', () => {
  it('lets reference images through for a model the catalog declares them on', () => {
    expect(() => assertReferenceImagesSupported(ImageModels.GPT_IMAGE_2, ['file-1'])).not.toThrow();
  });

  it('rejects them for a model that would drop them, including an uncatalogued local checkpoint', () => {
    expect(() => assertReferenceImagesSupported(ImageModels.GEMINI_3_PRO_IMAGE, ['file-1'])).toThrow(
      /reference images/
    );
    expect(() => assertReferenceImagesSupported('local-image/sdxl.safetensors', ['file-1'])).toThrow(
      /reference images/
    );
  });

  it('ignores an absent or empty list', () => {
    expect(() => assertReferenceImagesSupported(ImageModels.FLUX_PRO_1_1, undefined)).not.toThrow();
    expect(() => assertReferenceImagesSupported(ImageModels.FLUX_PRO_1_1, [])).not.toThrow();
  });
});
