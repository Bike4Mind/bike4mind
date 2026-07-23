import { Logger } from '@bike4mind/observability';
import { describe, expect, it, vi } from 'vitest';
import { ElevenLabsSoundGenerator } from './ElevenLabsSoundGenerator';

const logger = { error: vi.fn() } as unknown as Logger;

function mockFetch(body: string, ok = true, status = 200): typeof fetch {
  const bytes = new TextEncoder().encode(body);
  return vi.fn(async () => ({
    ok,
    status,
    arrayBuffer: async () => bytes.buffer,
    text: async () => body,
  })) as unknown as typeof fetch;
}

describe('ElevenLabsSoundGenerator', () => {
  it('throws when constructed without an API key', () => {
    expect(() => new ElevenLabsSoundGenerator({ apiKey: '', logger })).toThrow(/API key is required/);
  });

  it('POSTs to the sound-generation endpoint with the api key and prompt', async () => {
    const fetchImpl = mockFetch('audio-bytes');
    const generator = new ElevenLabsSoundGenerator({ apiKey: 'secret', logger, fetchImpl });

    const result = await generator.generate('dog barking', { durationSeconds: 3, promptInfluence: 0.5 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('https://api.elevenlabs.io/v1/sound-generation');
    expect(url).toContain('output_format=mp3_44100_128');
    expect(init.method).toBe('POST');
    expect(init.headers['xi-api-key']).toBe('secret');
    expect(JSON.parse(init.body)).toEqual({ text: 'dog barking', duration_seconds: 3, prompt_influence: 0.5 });

    expect(result.contentType).toBe('audio/mpeg');
    expect(result.audio.toString()).toBe('audio-bytes');
  });

  it('omits optional params when not provided', async () => {
    const fetchImpl = mockFetch('x');
    const generator = new ElevenLabsSoundGenerator({ apiKey: 'secret', logger, fetchImpl });

    await generator.generate('rain');

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ text: 'rain' });
  });

  it('maps the requested output format to the right content type', async () => {
    const fetchImpl = mockFetch('x');
    const generator = new ElevenLabsSoundGenerator({ apiKey: 'secret', logger, fetchImpl });

    const result = await generator.generate('beep', { format: 'pcm_44100' });

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('output_format=pcm_44100');
    expect(result.contentType).toBe('audio/L16');
  });

  it('throws with the upstream status and body on a non-ok response', async () => {
    const fetchImpl = mockFetch('quota exceeded', false, 401);
    const generator = new ElevenLabsSoundGenerator({ apiKey: 'secret', logger, fetchImpl });

    await expect(generator.generate('boom')).rejects.toThrow(/failed: 401 quota exceeded/);
  });
});
