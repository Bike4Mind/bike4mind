import { Logger } from '@bike4mind/observability';
import { describe, expect, it, vi } from 'vitest';
import { ElevenLabsSoundGenerator } from './ElevenLabsSoundGenerator';
import { aiSoundService } from './index';

const logger = { error: vi.fn() } as unknown as Logger;

describe('aiSoundService', () => {
  it('returns an ElevenLabs generator for the elevenlabs vendor', () => {
    expect(aiSoundService('elevenlabs', 'key', logger)).toBeInstanceOf(ElevenLabsSoundGenerator);
  });

  it('throws for an unknown vendor', () => {
    // Cast past the type guard to exercise the runtime default branch.
    expect(() => aiSoundService('nope' as 'elevenlabs', 'key', logger)).toThrow(/Unknown sound generation vendor/);
  });

  it('forwards timeoutMs so the provider fetch is aborted at that deadline', async () => {
    // Settles only when the request signal aborts, like a stalled provider round-trip.
    const stalledFetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );

    const generator = aiSoundService('elevenlabs', 'key', logger, {
      fetchImpl: stalledFetch as unknown as typeof fetch,
      timeoutMs: 20,
    });

    await expect(generator.generate('rain')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(stalledFetch).toHaveBeenCalledTimes(1);
  }, 2_000);
});
