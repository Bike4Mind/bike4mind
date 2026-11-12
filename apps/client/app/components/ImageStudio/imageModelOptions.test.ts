import { describe, expect, it } from 'vitest';
import { ImageModels } from '@bike4mind/common';
import {
  buildImageModelOptions,
  imageAspectRatioOptions,
  imageModelWhyNot,
  imageSizeOptions,
  pickDefaultImageModel,
} from './imageModelOptions';

const available = [
  { id: ImageModels.FLUX_KONTEXT_PRO, name: 'FLUX Kontext Pro' },
  { id: ImageModels.GEMINI_3_1_FLASH_IMAGE, name: 'Nano Banana 2' },
  { id: ImageModels.GPT_IMAGE_1_5, name: 'GPT Image 1.5' },
  { id: 'not-an-image-model', name: 'Unknown' },
];

describe('buildImageModelOptions', () => {
  it('keeps catalog models only, labelled by the model list', () => {
    const options = buildImageModelOptions(available, {});
    expect(options.map(option => option.model)).toEqual([
      ImageModels.FLUX_KONTEXT_PRO,
      ImageModels.GEMINI_3_1_FLASH_IMAGE,
      ImageModels.GPT_IMAGE_1_5,
    ]);
    expect(options[2]).toEqual({ model: ImageModels.GPT_IMAGE_1_5, label: 'GPT Image 1.5', disabledReason: null });
  });

  it('disables an edit-only model with its why-not reason', () => {
    const [kontext] = buildImageModelOptions(available, {});
    expect(kontext?.disabledReason).toEqual(expect.any(String));
    expect(kontext?.disabledReason).not.toBe('');
  });

  it('disables a model that cannot honour the chosen size', () => {
    expect(imageModelWhyNot(ImageModels.GEMINI_3_1_FLASH_IMAGE, { size: '1024x1536' })).toEqual(expect.any(String));
    expect(imageModelWhyNot(ImageModels.GPT_IMAGE_1_5, { size: '1024x1536' })).toBeNull();
  });
});

describe('pickDefaultImageModel', () => {
  it('opens on the first preferred model that can generate', () => {
    expect(pickDefaultImageModel(buildImageModelOptions(available, {}))).toBe(ImageModels.GPT_IMAGE_1_5);
  });

  it('falls back to the first usable model, and to none when nothing can generate', () => {
    const fluxOnly = buildImageModelOptions(
      [
        { id: ImageModels.FLUX_KONTEXT_PRO, name: 'Kontext' },
        { id: ImageModels.FLUX_PRO_ULTRA, name: 'Ultra' },
      ],
      {}
    );
    expect(pickDefaultImageModel(fluxOnly)).toBe(ImageModels.FLUX_PRO_ULTRA);
    expect(pickDefaultImageModel(fluxOnly.slice(0, 1))).toBeUndefined();
  });
});

describe('size and aspect ratio options', () => {
  it('lists the named sizes of a preset model and none for a fixed one', () => {
    expect(imageSizeOptions(ImageModels.GPT_IMAGE_1_5)).toContain('1024x1536');
    expect(imageSizeOptions(ImageModels.GEMINI_3_1_FLASH_IMAGE)).toEqual([]);
  });

  it('lists the ratios inside a ranged model and none for a model without ratios', () => {
    const ultra = imageAspectRatioOptions(ImageModels.FLUX_PRO_ULTRA);
    expect(ultra).toContain('16:9');
    expect(ultra).toContain('21:9');
    expect(imageAspectRatioOptions(ImageModels.GPT_IMAGE_1_5)).toEqual([]);
  });
});
