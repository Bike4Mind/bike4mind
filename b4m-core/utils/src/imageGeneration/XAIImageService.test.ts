import { describe, it, expect, vi, afterEach } from 'vitest';
import OpenAI from 'openai';
import { Logger } from '@bike4mind/observability';
import { toProviderEndUserId } from '@bike4mind/llm-adapters';
import { XAIImageService } from './XAIImageService';
import { ImageModerationBlockedError } from './imageGenerationErrors';

function apiError(status: number, message: string) {
  return OpenAI.APIError.generate(status, { error: { message } }, message, new Headers());
}

describe('XAIImageService.generate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends xAI the hashed end-user id, never the internal user id', async () => {
    const generate = vi
      .spyOn(OpenAI.Images.prototype, 'generate')
      .mockResolvedValue({ created: 0, data: [{ url: 'https://example.test/i.png' }] } as never);

    await new XAIImageService('key', new Logger()).generate('a prompt', { n: 1, user: 'u1' });

    expect(generate.mock.calls[0][0]).toMatchObject({ user: toProviderEndUserId('u1') });
  });

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
