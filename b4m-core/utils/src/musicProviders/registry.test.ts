import { describe, expect, it } from 'vitest';
import { LyriaMusicProvider } from './lyria/LyriaMusicProvider';
import { createMusicProviderRegistry } from './registry';

describe('createMusicProviderRegistry', () => {
  it('registers Lyria against the music catalog', () => {
    const lyria = new LyriaMusicProvider();
    expect(createMusicProviderRegistry([lyria]).get('gemini-lyria')).toBe(lyria);
  });
});
