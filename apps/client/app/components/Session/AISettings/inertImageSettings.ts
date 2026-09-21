import { isGeminiImageModel, usesDiscreteImageDimensions } from '@bike4mind/common';
// Imported from the module rather than the `help` barrel: component tests mock the barrel.
import { FIELD_TOOLTIPS } from '@client/app/components/help/fieldTooltips';

/**
 * True for image models that silently ignore Prompt Upsampling and Seed. Gemini's image API takes
 * neither: `GeminiImageService.buildGenerationConfig` omits `enhancePrompt` and `seed` from every
 * request because Google's `generateImages` rejects their mere presence, and the `generateContent`
 * fallback sends no config at all. Must stay in sync with that adapter.
 *
 * The controls stay rendered but disabled - hiding them would drop `prompt_upsampling` from image
 * templates snapshotted with a Gemini model (see `ImageTemplates/settingsSnapshot.ts`), and a
 * disabled control still tells you the setting exists on other providers.
 */
export const ignoresUpsamplingAndSeed = (model?: string | null): boolean => isGeminiImageModel(model);

/**
 * A model sized by discrete width/height builds its request from those alone - `BFLImageService.generate`
 * forwards `aspect_ratio` for Ultra only - so the Aspect Ratio control has no effect on it. Shares the
 * predicate with `imageSizeUpdate` so the size row and this row cannot disagree about a model.
 */
export const ignoresAspectRatio = usesDiscreteImageDimensions;

export const ASPECT_RATIO_INERT_NOTE = FIELD_TOOLTIPS.aspectRatioUnsupportedByFluxPro;

/** Adds the "your model ignores this" sentence to a field tooltip when the control is inert. */
export const withInertNote = (
  tooltip: string,
  inert: boolean,
  note: string = FIELD_TOOLTIPS.unsupportedByGeminiImage
): string => (inert ? `${tooltip} ${note}` : tooltip);
