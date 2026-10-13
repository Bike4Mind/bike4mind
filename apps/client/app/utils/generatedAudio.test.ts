import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toPlayableAudio } from './generatedAudio';

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:audio');
});

describe('toPlayableAudio', () => {
  it('plays the url variant straight from its URL without building a blob', () => {
    const playable = toPlayableAudio({
      delivery: 'url',
      url: 'https://s3/audio.mp3',
      bytes: 10,
      contentType: 'audio/mpeg',
    });

    expect(playable).toEqual({ url: 'https://s3/audio.mp3', isObjectUrl: false });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('decodes inline audio into a blob of the response content type', () => {
    const playable = toPlayableAudio({ audio: btoa('abc'), contentType: 'audio/wav' });

    expect(playable).toEqual({ url: 'blob:audio', isObjectUrl: true });
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(3);
  });
});
