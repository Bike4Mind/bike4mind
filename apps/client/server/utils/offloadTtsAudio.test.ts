import { describe, it, expect, vi, beforeEach } from 'vitest';

const { storage } = vi.hoisted(() => ({
  storage: { upload: vi.fn(), getSignedUrl: vi.fn() },
}));

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => storage,
}));

import { offloadTtsAudio, TTS_OFFLOAD_PREFIX, TTS_OFFLOAD_URL_TTL_SECONDS } from './offloadTtsAudio';

const audio = Buffer.from([1, 2, 3]);

beforeEach(() => {
  storage.upload.mockReset().mockResolvedValue(undefined);
  storage.getSignedUrl.mockReset().mockResolvedValue('https://s3/signed');
});

describe('offloadTtsAudio', () => {
  it('uploads under the transient prefix with the format extension and content type', async () => {
    await offloadTtsAudio({ audio, contentType: 'audio/wav', format: 'wav' });

    expect(storage.upload).toHaveBeenCalledTimes(1);
    const [body, key, options] = storage.upload.mock.calls[0];
    expect(body).toBe(audio);
    expect(key.startsWith(TTS_OFFLOAD_PREFIX)).toBe(true);
    expect(key.endsWith('.wav')).toBe(true);
    expect(options).toEqual({ ContentType: 'audio/wav' });
  });

  it('returns a time-limited signed GET URL for the uploaded key', async () => {
    const url = await offloadTtsAudio({ audio, contentType: 'audio/mpeg', format: 'mp3' });

    const key = storage.upload.mock.calls[0][1];
    expect(storage.getSignedUrl).toHaveBeenCalledWith(key, 'get', { expiresIn: TTS_OFFLOAD_URL_TTL_SECONDS });
    expect(url).toBe('https://s3/signed');
  });

  it('uses a distinct key per call', async () => {
    await offloadTtsAudio({ audio, contentType: 'audio/mpeg', format: 'mp3' });
    await offloadTtsAudio({ audio, contentType: 'audio/mpeg', format: 'mp3' });
    expect(storage.upload.mock.calls[0][1]).not.toBe(storage.upload.mock.calls[1][1]);
  });

  it('propagates an upload failure without signing a URL', async () => {
    storage.upload.mockRejectedValue(new Error('s3 down'));
    await expect(offloadTtsAudio({ audio, contentType: 'audio/mpeg', format: 'mp3' })).rejects.toThrow('s3 down');
    expect(storage.getSignedUrl).not.toHaveBeenCalled();
  });
});
