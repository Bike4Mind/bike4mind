import {
  canonicalizeTemplateSettings,
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
 * Build the settings blob from current LLMContext state. Shared by Save (what we
 * persist) and the controls indicator (what we match against saved templates), so
 * the two always produce the same shape. KEEP IN SYNC with ImageTemplateSettingsSchema.
 */
export function imageTemplateSettingsSnapshot(s: ImageSettingsSource): ImageTemplateSettingsType {
  return {
    size: s.size,
    quality: s.quality,
    style: s.style,
    seed: s.seed,
    n: s.n,
    width: s.width,
    height: s.height,
    aspect_ratio: s.aspect_ratio,
    output_format: s.output_format ?? undefined,
    safety_tolerance: s.safety_tolerance,
    prompt_upsampling: s.prompt_upsampling,
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
