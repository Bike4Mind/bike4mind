import { describe, it, expect } from 'vitest';
import { ImageModels } from '@bike4mind/common';
import { imageSizeUpdate } from './imageSizeUpdate';

describe('imageSizeUpdate', () => {
  it('carries the preset into width/height for Flux Pro models', () => {
    expect(imageSizeUpdate(ImageModels.FLUX_PRO_1_1, '1440x810')).toEqual({
      size: '1440x810',
      width: 1440,
      height: 810,
    });
  });

  it('clears width/height for models that do not take them, so a stale pair cannot resurface', () => {
    for (const model of [ImageModels.FLUX_PRO_ULTRA, ImageModels.FLUX_PRO_FILL, ImageModels.FLUX_KONTEXT_PRO, ImageModels.GPT_IMAGE_2, undefined]) {
      expect(imageSizeUpdate(model, '1024x1024')).toEqual({ size: '1024x1024', width: undefined, height: undefined });
    }
  });

  it('leaves dimensions unset when the preset is not parseable', () => {
    expect(imageSizeUpdate(ImageModels.FLUX_PRO_1_1, 'auto')).toEqual({
      size: 'auto',
      width: undefined,
      height: undefined,
    });
  });
});
