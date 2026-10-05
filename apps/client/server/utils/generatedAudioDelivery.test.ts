import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Response } from 'express';
import type { Logger } from '@bike4mind/observability';
import type { PersistGeneratedAudioResult } from '@server/utils/persistGeneratedAudio';

const { upload, getSignedUrl } = vi.hoisted(() => ({ upload: vi.fn(), getSignedUrl: vi.fn() }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload, getSignedUrl }),
}));

import {
  deliverGeneratedAudio,
  offloadGeneratedAudio,
  GENERATED_AUDIO_MAX_RESPONSE_BYTES,
  GENERATED_AUDIO_OFFLOAD_PREFIX,
  GENERATED_AUDIO_OFFLOAD_URL_TTL_SECONDS,
  GENERATED_AUDIO_TOO_LARGE_MESSAGE,
} from './generatedAudioDelivery';

type DeliverParams = Parameters<typeof deliverGeneratedAudio>[1];

const savedCopy: PersistGeneratedAudioResult = {
  saved: true,
  fabFileId: 'fab-1',
  fileName: 'audio-1.mp3',
  fileUrl: 'https://s3/saved',
};

const deliver = async (overrides: Partial<DeliverParams> = {}) => {
  const { res } = createMocks();
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  await deliverGeneratedAudio(res as unknown as Response, {
    audio: Buffer.from([1, 2, 3]),
    contentType: 'audio/mpeg',
    encoding: 'binary',
    save: undefined,
    logger: logger as unknown as Logger,
    ...overrides,
  });
  return { res, logger };
};

const oversized = () => Buffer.alloc(GENERATED_AUDIO_MAX_RESPONSE_BYTES + 1);

beforeEach(() => {
  upload.mockReset().mockResolvedValue(undefined);
  getSignedUrl.mockReset().mockResolvedValue('https://s3/offload');
});

describe('deliverGeneratedAudio', () => {
  describe('under the response limit', () => {
    it('sends inline bytes with Content-Type and Content-Length for binary', async () => {
      const { res } = await deliver();
      expect(res._getStatusCode()).toBe(200);
      expect(res.getHeader('Content-Type')).toBe('audio/mpeg');
      expect(res.getHeader('Content-Length')).toBe(3);
      expect(res._getData()).toEqual(Buffer.from([1, 2, 3]));
    });

    it('returns base64 JSON with delivery inline, merging endpoint fields', async () => {
      const { res } = await deliver({ encoding: 'base64', fields: { format: 'mp3' } });
      expect(res._getJSONData()).toEqual({
        delivery: 'inline',
        audio: Buffer.from([1, 2, 3]).toString('base64'),
        contentType: 'audio/mpeg',
        format: 'mp3',
      });
    });

    it('treats exactly the limit as inline and one byte more as oversized', async () => {
      const atLimit = await deliver({ audio: Buffer.alloc(GENERATED_AUDIO_MAX_RESPONSE_BYTES) });
      expect(atLimit.res._getStatusCode()).toBe(200);
      expect(upload).not.toHaveBeenCalled();

      const over = await deliver({ audio: oversized() });
      expect(over.res._getStatusCode()).toBe(303);
      expect(upload).toHaveBeenCalledTimes(1);
    });
  });

  describe('save headers', () => {
    it('sets all headers for a saved copy and the saved fields in base64 JSON', async () => {
      const { res } = await deliver({ save: savedCopy, encoding: 'base64' });
      expect(res.getHeader('X-B4M-Audio-Saved')).toBe('true');
      expect(res.getHeader('X-B4M-Audio-Fab-File-Id')).toBe('fab-1');
      expect(res.getHeader('X-B4M-Audio-File-Name')).toBe('audio-1.mp3');
      expect(res.getHeader('X-B4M-Audio-File-Url')).toBe('https://s3/saved');
      expect(res._getJSONData()).toMatchObject({
        saved: true,
        fabFileId: 'fab-1',
        fileName: 'audio-1.mp3',
        fileUrl: 'https://s3/saved',
      });
    });

    it('omits the File-Url header when the saved copy has no URL', async () => {
      const { res } = await deliver({ save: { saved: true, fabFileId: 'fab-1', fileName: 'a.mp3' } });
      expect(res.getHeader('X-B4M-Audio-File-Name')).toBe('a.mp3');
      expect(res.getHeader('X-B4M-Audio-File-Url')).toBeUndefined();
    });

    it('sets only Saved: false and reports the reason when the save was skipped', async () => {
      const { res } = await deliver({ save: { saved: false, reason: 'error' }, encoding: 'base64' });
      expect(res.getHeader('X-B4M-Audio-Saved')).toBe('false');
      expect(res.getHeader('X-B4M-Audio-Fab-File-Id')).toBeUndefined();
      expect(res._getJSONData()).toMatchObject({ saved: false, saveSkippedReason: 'error' });
    });

    it('sets no save headers or fields when no save was attempted', async () => {
      const { res } = await deliver({ encoding: 'base64' });
      expect(res.getHeader('X-B4M-Audio-Saved')).toBeUndefined();
      expect(res._getJSONData()).not.toHaveProperty('saved');
    });
  });

  describe('over the response limit', () => {
    it('uses the saved copy URL without uploading (binary 303, base64 url variant)', async () => {
      const audio = oversized();
      const binary = await deliver({ audio, save: savedCopy });
      expect(binary.res._getStatusCode()).toBe(303);
      expect(binary.res._getRedirectUrl()).toBe('https://s3/saved');

      const base64 = await deliver({ audio, save: savedCopy, encoding: 'base64' });
      expect(base64.res._getJSONData()).toMatchObject({
        delivery: 'url',
        url: 'https://s3/saved',
        bytes: audio.length,
        contentType: 'audio/mpeg',
      });
      expect(upload).not.toHaveBeenCalled();
    });

    it('offloads when there is no saved copy, or the saved copy has no URL', async () => {
      await deliver({ audio: oversized(), save: { saved: false, reason: 'storage_limit' } });
      await deliver({ audio: oversized(), save: { saved: true, fabFileId: 'f', fileName: 'a.mp3' } });
      expect(upload).toHaveBeenCalledTimes(2);
    });

    it('uploads under the offload prefix with the extension and ContentType, then signs a 1h GET URL', async () => {
      const audio = oversized();
      const { res } = await deliver({ audio });
      const [uploaded, key, options] = upload.mock.calls[0];
      expect(uploaded).toBe(audio);
      expect(key).toMatch(new RegExp(`^${GENERATED_AUDIO_OFFLOAD_PREFIX}[0-9a-f-]+\\.mp3$`));
      expect(options).toEqual({ ContentType: 'audio/mpeg' });
      expect(getSignedUrl).toHaveBeenCalledWith(key, 'get', { expiresIn: GENERATED_AUDIO_OFFLOAD_URL_TTL_SECONDS });
      expect(res._getRedirectUrl()).toBe('https://s3/offload');
    });

    it('falls back to a .bin key for an unknown content type', async () => {
      await deliver({ audio: oversized(), contentType: 'application/x-unknown' });
      expect(upload.mock.calls[0][1]).toMatch(/\.bin$/);
    });

    it('marks the 303 and the url JSON as no-store', async () => {
      const binary = await deliver({ audio: oversized() });
      expect(binary.res.getHeader('Cache-Control')).toBe('no-store');
      const base64 = await deliver({ audio: oversized(), encoding: 'base64' });
      expect(base64.res.getHeader('Cache-Control')).toBe('no-store');
      expect(base64.res._getJSONData()).toMatchObject({ delivery: 'url', url: 'https://s3/offload' });
    });

    it('does not set no-store on an inline response', async () => {
      const { res } = await deliver();
      expect(res.getHeader('Cache-Control')).toBeUndefined();
    });

    it('returns 413 with tooLargeFields and logs when the offload fails', async () => {
      upload.mockRejectedValue(new Error('s3 down'));
      const { res, logger } = await deliver({ audio: oversized(), tooLargeFields: { provider: 'openai' } });
      expect(res._getStatusCode()).toBe(413);
      expect(res._getJSONData()).toEqual({ error: GENERATED_AUDIO_TOO_LARGE_MESSAGE, provider: 'openai' });
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(res.getHeader('Cache-Control')).toBe('no-store');
    });
  });
});

describe('offloadGeneratedAudio', () => {
  it('propagates an upload rejection', async () => {
    upload.mockRejectedValue(new Error('s3 down'));
    await expect(offloadGeneratedAudio(Buffer.from([1]), 'audio/mpeg')).rejects.toThrow('s3 down');
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});
