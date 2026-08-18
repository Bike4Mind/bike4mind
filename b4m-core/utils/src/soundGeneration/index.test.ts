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
});
