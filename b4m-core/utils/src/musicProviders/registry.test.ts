import { describe, expect, it } from 'vitest';
import { ElevenLabsMusicProvider } from './elevenlabs/ElevenLabsMusicProvider';
import { LyriaMusicProvider } from './lyria/LyriaMusicProvider';
import { createMusicProviderRegistry } from './registry';

describe('createMusicProviderRegistry', () => {
  it('registers Lyria against the music catalog', () => {
    const lyria = new LyriaMusicProvider();
    expect(createMusicProviderRegistry([lyria]).get('gemini-lyria')).toBe(lyria);
  });

  it('registers ElevenLabs against the music catalog', () => {
    const elevenLabs = new ElevenLabsMusicProvider();
    expect(createMusicProviderRegistry([elevenLabs]).get('elevenlabs')).toBe(elevenLabs);
  });
});
