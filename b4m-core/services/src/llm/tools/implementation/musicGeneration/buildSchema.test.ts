import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildMusicToolSchema } from './buildSchema';

describe('buildMusicToolSchema', () => {
  it('offers only the usable models', () => {
    const { schema } = buildMusicToolSchema(['music_v2']);
    expect(schema.safeParse({ model: 'music_v2', prompt: 'p' }).success).toBe(true);
    expect(schema.safeParse({ model: 'lyria-3.5', prompt: 'p' }).success).toBe(false);
  });

  it('spans the duration bounds of every usable model, fixed lengths included', () => {
    const { schema } = buildMusicToolSchema(['lyria-3-clip-preview', 'music_v2']);
    const accepts = (durationSeconds: number) =>
      schema.safeParse({ model: 'music_v2', prompt: 'p', durationSeconds }).success;
    expect(accepts(3)).toBe(true);
    expect(accepts(300)).toBe(true);
    expect(accepts(2)).toBe(false);
    expect(accepts(301)).toBe(false);
  });

  it('caps lyrics at the largest limit among the usable models', () => {
    const { schema } = buildMusicToolSchema(['music_v1']);
    const accepts = (length: number) =>
      schema.safeParse({ model: 'music_v1', prompt: 'p', lyrics: 'a'.repeat(length) }).success;
    expect(accepts(4000)).toBe(true);
    expect(accepts(4001)).toBe(false);
  });

  it('describes each model and the guidance the model needs', () => {
    const { description } = buildMusicToolSchema(['test-music', 'lyria-3.5', 'lyria-3-clip-preview']);
    expect(description).toContain('- test-music (Test music (non-production))');
    expect(description).toContain('lyria-3.5 (Lyria 3.5): lyrics up to 10000 chars; 30-180, default 120, approximate');
    expect(description).toContain('always 30');
    expect(description).toMatch(/Never name a real artist/);
    const prompt = z.toJSONSchema(buildMusicToolSchema(['test-music']).schema).properties?.prompt;
    expect(JSON.stringify(prompt)).toMatch(/Never name a real artist or band.*Good:.*Bad:/);
  });

  it('converts to a JSON Schema without transforms', () => {
    const { schema } = buildMusicToolSchema(['test-music']);
    expect(() => z.toJSONSchema(schema)).not.toThrow();
  });
});
