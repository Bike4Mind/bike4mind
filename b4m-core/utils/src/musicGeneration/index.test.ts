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
});
