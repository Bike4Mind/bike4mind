import { describe, expect, it } from 'vitest';
import { GEMINI_IMAGE_MODELS, ImageModels } from '@bike4mind/common';
import { FIELD_TOOLTIPS } from '@client/app/components/help/fieldTooltips';
import { ASPECT_RATIO_INERT_NOTE, ignoresAspectRatio, ignoresUpsamplingAndSeed, withInertNote } from './inertImageSettings';

describe('ignoresUpsamplingAndSeed', () => {
  it('is true for every Gemini image model', () => {
    for (const model of GEMINI_IMAGE_MODELS) {
      expect(ignoresUpsamplingAndSeed(model)).toBe(true);
    }
  });

  it('is false for the providers that honor the two settings', () => {
    expect(ignoresUpsamplingAndSeed(ImageModels.FLUX_PRO_1_1)).toBe(false);
    expect(ignoresUpsamplingAndSeed(ImageModels.GPT_IMAGE_1)).toBe(false);
  });

  it('is false for a missing model rather than disabling the controls by default', () => {
    expect(ignoresUpsamplingAndSeed(undefined)).toBe(false);
    expect(ignoresUpsamplingAndSeed(null)).toBe(false);
    expect(ignoresUpsamplingAndSeed('')).toBe(false);
  });
});

describe('ignoresAspectRatio', () => {
  it('is true for the Flux Pro generation models, which size from width/height', () => {
    expect(ignoresAspectRatio(ImageModels.FLUX_PRO)).toBe(true);
    expect(ignoresAspectRatio(ImageModels.FLUX_PRO_1_1)).toBe(true);
  });

  it('is false for the models that do take an aspect ratio', () => {
    expect(ignoresAspectRatio(ImageModels.FLUX_PRO_ULTRA)).toBe(false);
    expect(ignoresAspectRatio(ImageModels.FLUX_KONTEXT_PRO)).toBe(false);
    expect(ignoresAspectRatio(ImageModels.GPT_IMAGE_2)).toBe(false);
    expect(ignoresAspectRatio(undefined)).toBe(false);
  });
});

describe('withInertNote', () => {
  it('appends the explanation when the control is inert', () => {
    expect(withInertNote(FIELD_TOOLTIPS.imageSeed, true)).toBe(
      `${FIELD_TOOLTIPS.imageSeed} ${FIELD_TOOLTIPS.unsupportedByGeminiImage}`
    );
  });

  it('appends the supplied note instead of the Gemini one when given', () => {
    expect(withInertNote(FIELD_TOOLTIPS.aspectRatio, true, ASPECT_RATIO_INERT_NOTE)).toBe(
      `${FIELD_TOOLTIPS.aspectRatio} ${ASPECT_RATIO_INERT_NOTE}`
    );
  });

  it('leaves the tooltip untouched otherwise', () => {
    expect(withInertNote(FIELD_TOOLTIPS.promptEnhancement, false)).toBe(FIELD_TOOLTIPS.promptEnhancement);
  });
});
