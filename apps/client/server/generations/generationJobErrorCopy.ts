import { SCENE_MAX_VIDEO_SECONDS, type GenerationJobErrorCode } from '@bike4mind/common';

/**
 * Fixed text per job error code. A stored job.error.message can carry provider wording, which never leaves the
 * server, so every surface that shows a job's error renders it from one of these tables.
 */
export type GenerationJobErrorCopy = Record<GenerationJobErrorCode, string>;

type Subject = { noun: string; plural: string };

/** The shared copy for one kind, named by its output; `overrides` is for a kind whose wording must differ. */
export function generationJobErrorCopy(
  { noun, plural }: Subject,
  overrides: Partial<GenerationJobErrorCopy> = {}
): GenerationJobErrorCopy {
  return {
    content_blocked: `The provider declined to generate this ${noun} under its content policy.`,
    provider_timeout: `The provider did not finish the ${noun} in time.`,
    provider_error: `The provider failed to generate the ${noun}.`,
    orphaned_submit: `The ${noun} could not be completed.`,
    region_unavailable: 'This model is not available in your region.',
    output_too_large: `The generated ${noun} exceeded the maximum size.`,
    input_image_not_found: 'The input image was not found.',
    enqueue_failed: `The ${noun} could not be started.`,
    cancelled: 'The generation was cancelled.',
    account_blocked: `This account cannot generate ${plural}.`,
    unsupported_input: `An input file could not be used for this ${noun}.`,
    ...overrides,
  };
}

// The video and music tables back the public v1 resources: their wording is part of the published contract.
export const VIDEO_JOB_ERROR_COPY = generationJobErrorCopy({ noun: 'video', plural: 'videos' });
export const MUSIC_JOB_ERROR_COPY = generationJobErrorCopy({ noun: 'song', plural: 'songs' });
// Published too, on the 202 the sync audio routes answer when a clip outlasts the request.
export const SPEECH_JOB_ERROR_COPY = generationJobErrorCopy({ noun: 'speech', plural: 'speech' });
export const SOUND_EFFECT_JOB_ERROR_COPY = generationJobErrorCopy({ noun: 'sound effect', plural: 'sound effects' });
export const IMAGE_JOB_ERROR_COPY = generationJobErrorCopy(
  { noun: 'image', plural: 'images' },
  {
    // Our own post-generation scan also blocks an image, so this copy does not name the provider.
    content_blocked: 'The image was declined under the content policy.',
    // An image job can take several inputs.
    input_image_not_found: 'An input image could not be found.',
  }
);

// A Scene is rendered by our own worker, so its copy never names a provider.
export const SCENE_JOB_ERROR_COPY = generationJobErrorCopy(
  { noun: 'Scene', plural: 'Scenes' },
  {
    provider_timeout: 'The Scene did not finish rendering in time.',
    provider_error: 'The Scene could not be rendered.',
    output_too_large: 'The rendered Scene exceeded the maximum size.',
    unsupported_input:
      'An input file is missing, unreadable, or outside the limits: the video needs a video stream and may run ' +
      `at most ${SCENE_MAX_VIDEO_SECONDS} seconds, the audio needs an audio stream, and the cover must be an image.`,
  }
);
