import {
  canonicalizeTemplateSettings,
  isBflImageModel,
  isKontextModel,
  ImageModels,
  type ImageTemplateSettingsType,
  type IImageGenerationTemplateDocument,
} from '@bike4mind/common';
import type { LLMContextProps } from '@client/app/contexts/LLMContext';

/** The image-mode fields captured into a template's `settings` blob. */
export type ImageSettingsSource = Pick<
  LLMContextProps,
  | 'size'
  | 'quality'
  | 'style'
  | 'seed'
  | 'n'
  | 'width'
  | 'height'
  | 'aspect_ratio'
  | 'output_format'
  | 'safety_tolerance'
  | 'prompt_upsampling'
>;

/**
 * Build the settings blob for a template from current LLMContext state, MODEL-AWARE:
 * only the fields the given model actually uses are included. This is load-bearing
 * for the derived indicator and dedup: LLMContext always carries BFL-only fields
 * with defaults (width:1024, height:768, prompt_upsampling:false) even on a GPT
 * model, and those are non-null so canonicalization keeps them - so a GPT template
 * (which correctly omits them) would never match a GPT snapshot. Gating the fields
 * by model family keeps both sides the same shape.
 *
 * KEEP IN SYNC with the per-model settings gating in AdvancedAIModal:
 *  - width/height/safety_tolerance/prompt_upsampling: BFL only
 *  - style: not GPT-Image-1, not BFL
 *  - size: not Kontext
 */
export function imageTemplateSettingsSnapshot(model: string, s: ImageSettingsSource): ImageTemplateSettingsType {
  const isBfl = isBflImageModel(model);
  const isKontext = isKontextModel(model);
  const isGpt1 = model === ImageModels.GPT_IMAGE_1;
  return {
    size: isKontext ? undefined : s.size,
    quality: s.quality,
    style: isGpt1 || isBfl ? undefined : s.style,
    seed: s.seed,
    n: s.n,
    width: isBfl && !isKontext ? s.width : undefined,
    height: isBfl && !isKontext ? s.height : undefined,
    aspect_ratio: s.aspect_ratio,
    output_format: s.output_format ?? undefined,
    safety_tolerance: isBfl ? s.safety_tolerance : undefined,
    prompt_upsampling: isBfl ? s.prompt_upsampling : undefined,
  };
}

/**
 * The template (if any) whose bound model AND settings match the given config -
 * exact-model + canonical settings equality. Save-time dedup guarantees at most
 * one match per model. Shared by the applied-template indicator and the send-time
 * usage increment so both agree on "these settings ARE this template".
 */
export function findMatchingTemplate(
  templates: IImageGenerationTemplateDocument[],
  model: string,
  settings: ImageTemplateSettingsType
): IImageGenerationTemplateDocument | undefined {
  const target = canonicalizeTemplateSettings(settings);
  return templates.find(t => t.model === model && canonicalizeTemplateSettings(t.settings) === target);
}
