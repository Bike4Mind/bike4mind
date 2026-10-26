import { describe, it, expect, vi, afterEach } from 'vitest';
import OpenAI from 'openai';
import { Logger } from '@bike4mind/observability';
import { XAIImageService } from './XAIImageService';
import { ImageModerationBlockedError } from './imageGenerationErrors';

function apiError(status: number, message: string) {
  return OpenAI.APIError.generate(status, { error: { message } }, message, new Headers());
}

describe('XAIImageService.generate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps the content-moderation 400 to ImageModerationBlockedError without error-logging', async () => {
    vi.spyOn(OpenAI.Images.prototype, 'generate').mockRejectedValue(
      apiError(400, 'Generated image rejected by content moderation.')
    );
    const errorSpy = vi.spyOn(Logger, 'error');

    const thrown = await new XAIImageService('key', new Logger())
      .generate('a prompt', { n: 1, user: 'u1' })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ImageModerationBlockedError);
    expect((thrown as ImageModerationBlockedError).logContext).toMatchObject({ provider: 'xai' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('still error-logs and wraps any other failure', async () => {
    vi.spyOn(OpenAI.Images.prototype, 'generate').mockRejectedValue(apiError(500, 'upstream exploded'));
    const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);

    const thrown = await new XAIImageService('key', new Logger())
      .generate('a prompt', { n: 1, user: 'u1' })
      .catch((error: unknown) => error);

    expect(thrown).not.toBeInstanceOf(ImageModerationBlockedError);
    expect((thrown as Error).message).toMatch(/^XAI image generation failed:/);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
