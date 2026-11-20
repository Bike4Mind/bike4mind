import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { RekognitionClient } from '@aws-sdk/client-rekognition';
import { Logger } from '@bike4mind/observability';

// A decoder that cannot start is a deployment fault, so it must not be mistaken for an unscannable image.
vi.mock('./webpDecode', async importOriginal => {
  const actual = await importOriginal<typeof import('./webpDecode')>();
  return {
    ...actual,
    decodeWebp: vi.fn(async () => {
      throw new actual.WebpDecoderUnavailableError(new Error('wasm failed to instantiate'));
    }),
  };
});

import { RekognitionImageModerationService, UnsupportedImageFormatError, WebpDecoderUnavailableError } from './index';

const STILL_WEBP = readFileSync(new URL('./__fixtures__/still-red.webp', import.meta.url));

describe('RekognitionImageModerationService with the WebP decoder unavailable', () => {
  it('rethrows WebpDecoderUnavailableError (transient) instead of an unsupported format, without calling Rekognition', async () => {
    const send = vi.fn(async () => ({ ModerationLabels: [] }));
    const logger = Logger.globalInstance;
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const service = new RekognitionImageModerationService(logger, { send } as unknown as RekognitionClient);

    const rejection = service.checkImage(STILL_WEBP, 'image/webp');

    await expect(rejection).rejects.toBeInstanceOf(WebpDecoderUnavailableError);
    await expect(rejection).rejects.not.toBeInstanceOf(UnsupportedImageFormatError);
    expect(send).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('WebP decoder unavailable'));
  });
});
