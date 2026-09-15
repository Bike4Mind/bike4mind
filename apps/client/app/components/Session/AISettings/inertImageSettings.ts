import { isGeminiImageModel } from '@bike4mind/common';
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

/** Adds the "your model ignores this" sentence to a field tooltip when the control is inert. */
export const withInertNote = (tooltip: string, inert: boolean): string =>
  inert ? `${tooltip} ${FIELD_TOOLTIPS.unsupportedByGeminiImage}` : tooltip;
