import { Logger } from '@bike4mind/observability';
import { describe, expect, it, vi } from 'vitest';
import { ElevenLabsMusicGenerator } from './ElevenLabsMusicGenerator';
import { aiMusicService } from './index';

const logger = { error: vi.fn() } as unknown as Logger;

describe('aiMusicService', () => {
  it('returns an ElevenLabs generator for the elevenlabs vendor', () => {
    expect(aiMusicService('elevenlabs', 'key', logger)).toBeInstanceOf(ElevenLabsMusicGenerator);
  });

  it('throws for an unknown vendor', () => {
    // Cast past the type guard to exercise the runtime default branch.
    expect(() => aiMusicService('nope' as 'elevenlabs', 'key', logger)).toThrow(/Unknown music generation vendor/);
  });

  it('forwards timeoutMs so the provider fetch is aborted at that deadline', async () => {
    // Settles only when the request signal aborts, like a stalled provider round-trip.
    const stalledFetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );

    const generator = aiMusicService('elevenlabs', 'key', logger, {
      fetchImpl: stalledFetch as unknown as typeof fetch,
      timeoutMs: 20,
    });

    await expect(generator.generate('drone')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(stalledFetch).toHaveBeenCalledTimes(1);
  }, 2_000);
});
