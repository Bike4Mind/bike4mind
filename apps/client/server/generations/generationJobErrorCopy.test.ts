import { describe, expect, it } from 'vitest';
import { GENERATION_JOB_ERROR_CODES } from '@bike4mind/common';
import {
  generationJobErrorCopy,
  IMAGE_JOB_ERROR_COPY,
  MUSIC_JOB_ERROR_COPY,
  VIDEO_JOB_ERROR_COPY,
} from './generationJobErrorCopy';

describe('generationJobErrorCopy', () => {
  it('names the output in every code that refers to it', () => {
    const copy = generationJobErrorCopy({ noun: 'clip', plural: 'clips' });
    expect(copy).toEqual({
      content_blocked: 'The provider declined to generate this clip under its content policy.',
      provider_timeout: 'The provider did not finish the clip in time.',
      provider_error: 'The provider failed to generate the clip.',
      orphaned_submit: 'The clip could not be completed.',
      region_unavailable: 'This model is not available in your region.',
      output_too_large: 'The generated clip exceeded the maximum size.',
      input_image_not_found: 'The input image was not found.',
      enqueue_failed: 'The clip could not be started.',
      cancelled: 'The generation was cancelled.',
      account_blocked: 'This account cannot generate clips.',
    });
  });

  it('lets a kind override single codes and keeps the rest', () => {
    const copy = generationJobErrorCopy({ noun: 'clip', plural: 'clips' }, { cancelled: 'Stopped.' });
    expect(copy.cancelled).toBe('Stopped.');
    expect(copy.provider_error).toBe('The provider failed to generate the clip.');
  });

  it.each([
    ['video', VIDEO_JOB_ERROR_COPY],
    ['music', MUSIC_JOB_ERROR_COPY],
    ['image', IMAGE_JOB_ERROR_COPY],
  ])('has non-empty %s copy for every code', (_kind, copy) => {
    for (const code of GENERATION_JOB_ERROR_CODES) expect(copy[code]).toMatch(/\S/);
  });

  // The Studio image route rendered these before the tables were shared; pinned so the move changes no text.
  it('keeps the Studio image wording', () => {
    expect(IMAGE_JOB_ERROR_COPY).toEqual({
      content_blocked: 'The image was declined under the content policy.',
      provider_timeout: 'The provider did not finish the image in time.',
      provider_error: 'The provider failed to generate the image.',
      orphaned_submit: 'The image could not be completed.',
      region_unavailable: 'This model is not available in your region.',
      output_too_large: 'The generated image exceeded the maximum size.',
      input_image_not_found: 'An input image could not be found.',
      enqueue_failed: 'The image could not be started.',
      cancelled: 'The generation was cancelled.',
      account_blocked: 'This account cannot generate images.',
    });
  });
});
