import { Logger } from '@bike4mind/observability';
import { describe, expect, it, vi } from 'vitest';
import { ElevenLabsMusicGenerator, MUSIC_GENERATION_TIMEOUT_MS } from './ElevenLabsMusicGenerator';

const logger = { error: vi.fn() } as unknown as Logger;

// The hosted serving function's own cap (infra/web.ts). The provider deadline
// must stay strictly under it - that ordering IS the credit-loss guarantee.
const SERVING_FUNCTION_TIMEOUT_MS = 60_000;

/** Never settles on its own; only the caller's AbortSignal can end it. */
const hangingFetch: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason));
  });

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

  it('aborts a stalled provider round-trip so the route can refund the reservation', async () => {
    const generator = new ElevenLabsMusicGenerator({
      apiKey: 'secret',
      logger,
      fetchImpl: hangingFetch,
      timeoutMs: 20,
    });

    // A signal that never fires (or fires after the function is dead) destroys the
    // reservation instead of refunding it, so assert the deadline actually elapses -
    // not merely that some AbortSignal was attached.
    await expect(generator.generate('drone')).rejects.toMatchObject({ name: 'TimeoutError' });
  }, 2_000); // disarms the signal fails fast instead of stalling the suite for the default 5s. // Short ceiling: the 20ms deadline should fire instantly, so a regression that

  it('arms the default deadline, and that deadline fits inside the serving function budget', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl = mockFetch('x');
    const generator = new ElevenLabsMusicGenerator({ apiKey: 'secret', logger, fetchImpl });

    await generator.generate('drone');

    expect(timeoutSpy).toHaveBeenCalledWith(MUSIC_GENERATION_TIMEOUT_MS);
    // Raising the constant past the function cap silently reintroduces the
    // charge-without-refund hole, so pin the relationship, not just the value.
    expect(MUSIC_GENERATION_TIMEOUT_MS).toBeLessThan(SERVING_FUNCTION_TIMEOUT_MS);
    timeoutSpy.mockRestore();
  });

  it('throws on an empty 200 body so a 0-byte track is never billed or persisted', async () => {
    const fetchImpl = mockFetch('');
    const generator = new ElevenLabsMusicGenerator({ apiKey: 'secret', logger, fetchImpl });

    await expect(generator.generate('silence')).rejects.toThrow(/returned no audio/);
  });

  it('maps the requested output format to the right content type', async () => {
    const fetchImpl = mockFetch('x');
    const generator = new ElevenLabsMusicGenerator({ apiKey: 'secret', logger, fetchImpl });

    const result = await generator.generate('beep', { format: 'pcm_44100' });

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('output_format=pcm_44100');
    expect(result.contentType).toBe('audio/L16');
  });

  it.each([
    ['opus_48000_128', 'audio/opus'],
    ['ulaw_8000', 'audio/basic'],
    ['not_a_codec', 'application/octet-stream'],
  ])('maps %s to %s', async (format, expected) => {
    const generator = new ElevenLabsMusicGenerator({ apiKey: 'secret', logger, fetchImpl: mockFetch('x') });

    expect((await generator.generate('beep', { format })).contentType).toBe(expected);
  });

  it('forwards forceInstrumental: false rather than dropping it as falsy', async () => {
    const fetchImpl = mockFetch('x');
    const generator = new ElevenLabsMusicGenerator({ apiKey: 'secret', logger, fetchImpl });

    await generator.generate('vocal track', { forceInstrumental: false });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body).force_instrumental).toBe(false);
  });

  it('throws with the upstream status and body on a non-ok response', async () => {
    const fetchImpl = mockFetch('quota exceeded', false, 401);
    const generator = new ElevenLabsMusicGenerator({ apiKey: 'secret', logger, fetchImpl });

    await expect(generator.generate('boom')).rejects.toThrow(/failed: 401 quota exceeded/);
  });
});
