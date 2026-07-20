import { describe, it, expect } from 'vitest';
import { recommendAspectRatio } from './recommendations';

describe('recommendAspectRatio', () => {
  it('recommends 3:4 for portrait-ish prompts', () => {
    expect(recommendAspectRatio('A photorealistic portrait of a person')?.aspectRatio).toBe('3:4');
    expect(recommendAspectRatio('full-body shot, standing')?.label).toBe('portrait');
  });

  it('recommends 16:9 for landscape-ish prompts', () => {
    expect(recommendAspectRatio('a sweeping mountain landscape at dawn')?.aspectRatio).toBe('16:9');
    expect(recommendAspectRatio('a city skyline panorama')?.aspectRatio).toBe('16:9');
  });

  it('recommends 1:1 for square-ish prompts', () => {
    expect(recommendAspectRatio('a minimalist logo')?.aspectRatio).toBe('1:1');
    expect(recommendAspectRatio('a profile picture avatar')?.aspectRatio).toBe('1:1');
  });

  it('returns null when nothing matches or the prompt is empty', () => {
    expect(recommendAspectRatio('a cat wearing a hat')).toBeNull();
    expect(recommendAspectRatio('   ')).toBeNull();
  });

  it('matches whole words only (no firing inside other words)', () => {
    expect(recommendAspectRatio('an iconic moment')).toBeNull(); // 'icon' must not match 'iconic'
    expect(recommendAspectRatio('a deep understanding of physics')).toBeNull(); // 'standing' not in 'understanding'
    expect(recommendAspectRatio('a tall lighthouse')?.aspectRatio).toBe('3:4'); // 'tall' as a real word still matches
  });
});
