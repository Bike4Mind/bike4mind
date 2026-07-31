import { Logger } from '@bike4mind/observability';
import { describe, expect, it, vi } from 'vitest';
import { ElevenLabsMusicGenerator } from './ElevenLabsMusicGenerator';

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

describe('ElevenLabsMusicGenerator', () => {
  it('throws when constructed without an API key', () => {
    expect(() => new ElevenLabsMusicGenerator({ apiKey: '', logger })).toThrow(/API key is required/);
  });

  it('POSTs to the music endpoint with the api key, prompt, model, and length', async () => {
    const fetchImpl = mockFetch('music-bytes');
    const generator = new ElevenLabsMusicGenerator({ apiKey: 'secret', logger, fetchImpl });

    const result = await generator.generate('lofi hip hop beat', { lengthMs: 30000, forceInstrumental: true });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('https://api.elevenlabs.io/v1/music');
    expect(url).toContain('output_format=mp3_44100_128');
    expect(init.method).toBe('POST');
    expect(init.headers['xi-api-key']).toBe('secret');
    expect(JSON.parse(init.body)).toEqual({
      prompt: 'lofi hip hop beat',
      model_id: 'music_v1',
      music_length_ms: 30000,
      force_instrumental: true,
    });

    expect(result.contentType).toBe('audio/mpeg');
    expect(result.audio.toString()).toBe('music-bytes');
  });

  it('defaults the model and omits optional params when not provided', async () => {
    const fetchImpl = mockFetch('x');
    const generator = new ElevenLabsMusicGenerator({ apiKey: 'secret', logger, fetchImpl });

    await generator.generate('ambient pad');

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ prompt: 'ambient pad', model_id: 'music_v1' });
  });

  it('arms an abort signal so a slow provider round-trip cannot outlive the serving function', async () => {
    const fetchImpl = mockFetch('x');
    const generator = new ElevenLabsMusicGenerator({ apiKey: 'secret', logger, fetchImpl });

    await generator.generate('drone');

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    // The route's catch/refund path only runs if the fetch can reject on timeout.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps the requested output format to the right content type', async () => {
    const fetchImpl = mockFetch('x');
    const generator = new ElevenLabsMusicGenerator({ apiKey: 'secret', logger, fetchImpl });

    const result = await generator.generate('beep', { format: 'pcm_44100' });

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('output_format=pcm_44100');
    expect(result.contentType).toBe('audio/L16');
  });

  it('throws with the upstream status and body on a non-ok response', async () => {
    const fetchImpl = mockFetch('quota exceeded', false, 401);
    const generator = new ElevenLabsMusicGenerator({ apiKey: 'secret', logger, fetchImpl });

    await expect(generator.generate('boom')).rejects.toThrow(/failed: 401 quota exceeded/);
  });
});
