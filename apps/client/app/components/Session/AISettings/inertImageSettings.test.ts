import { describe, expect, it } from 'vitest';
import { GEMINI_IMAGE_MODELS, ImageModels } from '@bike4mind/common';
import { FIELD_TOOLTIPS } from '@client/app/components/help/fieldTooltips';
import {
  ASPECT_RATIO_INERT_NOTE,
  ignoresAspectRatio,
  ignoresOutputFormat,
  ignoresSeed,
  ignoresUpsamplingAndSeed,
  seedInertNote,
  withInertNote,
} from './inertImageSettings';

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

describe('ignoresSeed and ignoresOutputFormat', () => {
  it('marks Seed and Output Format inert on flux-3-image, whose endpoint defines neither', () => {
    expect(ignoresSeed(ImageModels.FLUX_3_IMAGE)).toBe(true);
    expect(ignoresOutputFormat(ImageModels.FLUX_3_IMAGE)).toBe(true);
    expect(seedInertNote(ImageModels.FLUX_3_IMAGE)).toBe(FIELD_TOOLTIPS.unsupportedByFlux3Image);
  });

  it('keeps both live on FLUX 3 Image Klein and the other BFL models', () => {
    for (const model of [ImageModels.FLUX_3_IMAGE_KLEIN, ImageModels.FLUX_2_PRO, ImageModels.FLUX_PRO_1_1]) {
      expect(ignoresSeed(model)).toBe(false);
      expect(ignoresOutputFormat(model)).toBe(false);
    }
  });

  it('still marks Seed inert on Gemini, with the Gemini note', () => {
    expect(ignoresSeed(ImageModels.GEMINI_3_PRO_IMAGE)).toBe(true);
    expect(seedInertNote(ImageModels.GEMINI_3_PRO_IMAGE)).toBe(FIELD_TOOLTIPS.unsupportedByGeminiImage);
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
