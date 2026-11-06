import type { ImageOutputFormat, OpenAIImageQuality, OpenAIImageStyle } from '../schemas/openai';
import { joinWithOr, pluralize, reasonFor, type ReasonTable } from '../utils/capabilityReasons';
import type { ImageSizing } from '../utils/imageCapabilities';
import type { AspectRatioCapability, ImageInputRole, ImageMode } from './types';
import type { ImageValidationErrorCode } from './validate';

/** The context behind each image validation failure, keyed on its code. Read by imageFailureReason. */
export type ImageFailureDetail =
  | { code: 'unsupported_mode'; mode: ImageMode }
  | { code: 'missing_input'; role: ImageInputRole }
  | { code: 'unexpected_input'; role: ImageInputRole }
  | { code: 'unsupported_input_role'; role: ImageInputRole }
  | { code: 'too_many_inputs'; role: ImageInputRole; max: number; requested: number }
  | { code: 'unsupported_size'; requested: string; sizing: ImageSizing }
  | { code: 'unsupported_aspect_ratio'; requested: string; mode: ImageMode; allowed: AspectRatioCapability | null }
  | { code: 'unsupported_quality'; requested: OpenAIImageQuality; allowed: readonly OpenAIImageQuality[] }
  | { code: 'unsupported_style'; requested: OpenAIImageStyle; allowed: readonly OpenAIImageStyle[] }
  | {
      code: 'unsupported_output_format';
      requested: ImageOutputFormat;
      allowed: readonly ImageOutputFormat[];
      // True when the format is listed but cannot carry the transparent background the request asked for.
      needsAlpha: boolean;
    }
  | { code: 'unsupported_output_count'; requested: number; max: number }
  | { code: 'unsupported_transparent_background' }
  | { code: 'unsupported_seed' };

const ROLE_NOUN: Record<ImageInputRole, { singular: string; plural: string }> = {
  edit_source: { singular: 'source image', plural: 'source images' },
  mask: { singular: 'mask', plural: 'masks' },
  reference: { singular: 'reference image', plural: 'reference images' },
};

const MODE_VERB: Record<ImageMode, string> = { generate: 'generate new images', edit: 'edit images' };

function sizeReason(requested: string, sizing: ImageSizing): string {
  switch (sizing.kind) {
    case 'presets':
      return `This model supports ${joinWithOr(sizing.presets)}; you asked for ${requested}`;
    case 'constrained':
      return `This model cannot render ${requested}; pick a preset or ${sizing.autoSize}`;
    case 'dimensions':
      return `This model supports ${sizing.minWidth}-${sizing.maxWidth} x ${sizing.minHeight}-${sizing.maxHeight} in ${sizing.step}px steps; you asked for ${requested}`;
    case 'aspectRatio':
      return 'This model takes an aspect ratio, not a size';
    case 'inputImage':
      return 'This model keeps the size of its input image';
    case 'fixed':
      return 'This model takes no size';
  }
}

function aspectRatioReason(requested: string, mode: ImageMode, allowed: AspectRatioCapability | null): string {
  if (!allowed) return `This model takes no aspect ratio when asked to ${MODE_VERB[mode]}`;
  const range = allowed.kind === 'discrete' ? joinWithOr(allowed.values) : `${allowed.tallest} to ${allowed.widest}`;
  return `This model supports ${range}; you asked for ${requested}`;
}

const optionReason = (setting: string, requested: string, allowed: readonly string[]): string =>
  allowed.length === 0
    ? `This model has no ${setting} setting`
    : `This model supports ${joinWithOr(allowed)} ${setting}; you asked for ${requested}`;

const IMAGE_REASONS: ReasonTable<ImageValidationErrorCode, ImageFailureDetail> = {
  unsupported_mode: ({ mode }) => `This model cannot ${MODE_VERB[mode]}`,
  missing_input: ({ role }) => `Editing with this model needs a ${ROLE_NOUN[role].singular}`,
  unexpected_input: ({ role }) => `A ${ROLE_NOUN[role].singular} only applies when editing`,
  unsupported_input_role: ({ role }) => `This model takes no ${ROLE_NOUN[role].plural}`,
  too_many_inputs: ({ role, max, requested }) =>
    `This model takes up to ${pluralize(max, ROLE_NOUN[role].singular, ROLE_NOUN[role].plural)}; you added ${requested}`,
  unsupported_size: ({ requested, sizing }) => sizeReason(requested, sizing),
  unsupported_aspect_ratio: ({ requested, mode, allowed }) => aspectRatioReason(requested, mode, allowed),
  unsupported_quality: ({ requested, allowed }) => optionReason('quality', requested, allowed),
  unsupported_style: ({ requested, allowed }) => optionReason('style', requested, allowed),
  unsupported_output_format: ({ requested, allowed, needsAlpha }) => {
    if (needsAlpha) return `${requested.toUpperCase()} cannot keep a transparent background; pick PNG or WEBP`;
    if (allowed.length === 0) return 'This model has no output format setting';
    return `This model outputs ${joinWithOr(allowed.map(format => format.toUpperCase()))}; you asked for ${requested.toUpperCase()}`;
  },
  unsupported_output_count: ({ requested, max }) =>
    max === 1
      ? `This model makes one image per request; you asked for ${requested}`
      : `This model makes up to ${max} images per request; you asked for ${requested}`,
  unsupported_transparent_background: () => 'This model cannot render a transparent background',
  unsupported_seed: () => 'This model does not take a seed',
};

/** A short, user-facing "why not" for one image validation failure, e.g. for a greyed-out model card. */
export const imageFailureReason = (detail: ImageFailureDetail): string => reasonFor(IMAGE_REASONS, detail);
