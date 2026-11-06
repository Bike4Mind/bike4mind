import { joinWithOr, outOfBoundsPhrase, pluralize, reasonFor, type ReasonTable } from '../utils/capabilityReasons';
import type { AspectRatio, DurationCapability, ResolutionTier, VideoInputRole, VideoMode } from './types';
import type { VideoValidationErrorCode } from './validate';

/**
 * The context behind each video validation failure, keyed on its code. `model` is the display name, so the
 * reason can name it. Read by videoFailureReason.
 */
export type VideoFailureDetail = { model: string } & (
  | { code: 'unsupported_mode'; mode: VideoMode }
  | { code: 'missing_input_image' }
  | { code: 'unexpected_input_image'; cause: 'conflicting_image_fields' }
  | { code: 'unexpected_input_image'; cause: 'frame_without_image_mode'; role: VideoInputRole }
  // `max` is 0 when the model takes no input of this role at all.
  | { code: 'unsupported_input_role'; role: VideoInputRole; max: number; requested: number }
  | { code: 'unsupported_duration'; requested: number; allowed: DurationCapability }
  | { code: 'unsupported_aspect_ratio'; requested: AspectRatio; allowed: readonly AspectRatio[] }
  | { code: 'unsupported_resolution'; requested: ResolutionTier; allowed: readonly ResolutionTier[] }
  | { code: 'unsupported_audio_option'; audio: 'always' | 'none' }
);

const ROLE_NOUN: Record<VideoInputRole, { singular: string; plural: string }> = {
  first_frame: { singular: 'first-frame image', plural: 'first-frame images' },
  last_frame: { singular: 'last-frame image', plural: 'last-frame images' },
  reference: { singular: 'reference image', plural: 'reference images' },
  style: { singular: 'style image', plural: 'style images' },
};

const MODE_PHRASE: Record<VideoMode, string> = {
  text_to_video: 'make video from text alone',
  image_to_video: 'turn an image into video',
};

function durationReason(model: string, requested: number, allowed: DurationCapability): string {
  const [min, max] =
    allowed.kind === 'discrete'
      ? [Math.min(...allowed.values), Math.max(...allowed.values)]
      : [allowed.min, allowed.max];
  const bounds = outOfBoundsPhrase(requested, min, max, 's');
  const supported =
    bounds ??
    (allowed.kind === 'discrete'
      ? `${joinWithOr(allowed.values.map(String))}s`
      : `${allowed.min}-${allowed.max}s in ${allowed.step}s steps`);
  return `${model} supports ${supported}; you asked for ${requested}s`;
}

function inputRoleReason(model: string, role: VideoInputRole, max: number, requested: number): string {
  const noun = ROLE_NOUN[role];
  if (max === 0) return `${model} takes no ${noun.plural}`;
  return `${model} takes up to ${pluralize(max, noun.singular, noun.plural)}; you added ${requested}`;
}

const VIDEO_REASONS: ReasonTable<VideoValidationErrorCode, VideoFailureDetail> = {
  unsupported_mode: ({ model, mode }) => `${model} cannot ${MODE_PHRASE[mode]}`,
  missing_input_image: () => 'Image to video needs a first-frame image',
  unexpected_input_image: detail =>
    detail.cause === 'conflicting_image_fields'
      ? 'Attach the starting image one way only'
      : `A ${ROLE_NOUN[detail.role].singular} only applies to image to video`,
  unsupported_input_role: ({ model, role, max, requested }) => inputRoleReason(model, role, max, requested),
  unsupported_duration: ({ model, requested, allowed }) => durationReason(model, requested, allowed),
  unsupported_aspect_ratio: ({ model, requested, allowed }) =>
    `${model} supports ${joinWithOr(allowed)}; you asked for ${requested}`,
  unsupported_resolution: ({ model, requested, allowed }) =>
    `${model} supports ${joinWithOr(allowed)}; you asked for ${requested}`,
  unsupported_audio_option: ({ model, audio }) =>
    audio === 'always' ? `${model} always generates audio` : `${model} generates silent video only`,
};

/** A short, user-facing "why not" for one video validation failure, e.g. for a greyed-out model card. */
export const videoFailureReason = (detail: VideoFailureDetail): string => reasonFor(VIDEO_REASONS, detail);
