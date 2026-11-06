import { describe, it, expect, vi } from 'vitest';
import { insufficientCreditsError, UnprocessableEntityError } from '@bike4mind/common';
import {
  ImageInputRejectedError,
  ImageModerationBlockedError,
  ImageProviderUnavailableError,
  logImageGenerationFailure,
} from './imageGenerationErrors';
import { ImageModerationBlockedError as OwnModerationBlockedError } from '../imageModeration';

const makeLogger = () => ({ warn: vi.fn(), error: vi.fn() });

describe('logImageGenerationFailure', () => {
  it.each([
    ['moderation_blocked', new ImageModerationBlockedError('blocked', 'req-1', 'bfl', 'Request Moderated')],
    ['provider_unavailable', new ImageProviderUnavailableError('slow', { provider: 'bfl', reason: 'polling_timeout' })],
    ['input_rejected', new ImageInputRejectedError('no image', { reason: 'missing_input_image' })],
  ])('logs an expected %s failure at warn, never error', (kind, error) => {
    const logger = makeLogger();

    logImageGenerationFailure(logger, 'Image generation failed:', error);

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Image generation failed:', expect.objectContaining({ kind }));
  });

  it('logs the expected-failure diagnostics, not the user-facing message', () => {
    const logger = makeLogger();

    logImageGenerationFailure(logger, 'failed', new ImageModerationBlockedError('blocked', 'req-1', 'xai'));

    expect(logger.warn).toHaveBeenCalledWith('failed', {
      kind: 'moderation_blocked',
      provider: 'xai',
      requestId: 'req-1',
    });
  });

  it('logs our own post-generation moderation block at warn with the label names', () => {
    const logger = makeLogger();
    const error = new OwnModerationBlockedError([
      { name: 'Explicit', parentName: '', confidence: 93.3 },
      { name: 'Explicit Nudity', parentName: 'Explicit', confidence: 93.3 },
    ]);

    logImageGenerationFailure(logger, 'Error processing image generation:', error, { questId: 'q-1' });

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Error processing image generation:', {
      questId: 'q-1',
      kind: 'moderation_blocked',
      provider: 'rekognition',
      labels: ['Explicit', 'Explicit Nudity'],
    });
  });

  it('keeps an unrelated error that merely shares the name at error', () => {
    const logger = makeLogger();
    const error = new Error('lookalike');
    error.name = 'ImageModerationBlockedError';

    logImageGenerationFailure(logger, 'failed', error);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('failed', error);
  });

  it('logs an insufficient-credits refusal at warn with its code and message', () => {
    const logger = makeLogger();
    const error = insufficientCreditsError('You do not have enough credits for image generation.');

    logImageGenerationFailure(logger, 'failed', error, { questId: 'q1' });

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('failed', {
      questId: 'q1',
      errorCode: 'insufficient_credits',
      detail: 'You do not have enough credits for image generation.',
    });
  });

  it('logs an untagged 422 (e.g. a failed credit hold) at error', () => {
    const logger = makeLogger();
    const error = new UnprocessableEntityError('Credit hold failed');

    logImageGenerationFailure(logger, 'failed', error);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('failed', error);
  });

  it('logs any other failure at error', () => {
    const logger = makeLogger();
    const error = new Error('boom');

    logImageGenerationFailure(logger, 'failed', error);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('failed', error);
  });

  it('keeps the OpenAI-era constructor shape for ImageModerationBlockedError', () => {
    const error = new ImageModerationBlockedError('blocked', 'req-1');

    expect(error.requestId).toBe('req-1');
    expect(error.logContext).toEqual({ provider: 'openai', requestId: 'req-1' });
    expect(error.name).toBe('ImageModerationBlockedError');
  });
});
