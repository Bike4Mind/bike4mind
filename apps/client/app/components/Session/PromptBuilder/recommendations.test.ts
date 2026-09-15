import { describe, it, expect } from 'vitest';
import { recommendOrientation } from './recommendations';

// A non-GPT model steers orientation via aspect_ratio; a GPT-Image model via size.
const FLUX = 'flux-pro-1.1';
const GPT = 'gpt-image-1';

describe('recommendOrientation', () => {
  describe('non-GPT models (aspect_ratio)', () => {
    it('recommends 3:4 for portrait-ish prompts', () => {
      expect(recommendOrientation('A photorealistic portrait of a person', FLUX)).toEqual({
        label: 'portrait',
        settingKey: 'aspect_ratio',
        value: '3:4',
      });
      expect(recommendOrientation('full-body shot, standing', FLUX)?.label).toBe('portrait');
    });

    it('recommends 16:9 for landscape-ish prompts', () => {
      expect(recommendOrientation('a sweeping mountain landscape at dawn', FLUX)?.value).toBe('16:9');
      expect(recommendOrientation('a city skyline panorama', FLUX)?.value).toBe('16:9');
    });

    it('recommends 1:1 for square-ish prompts', () => {
      expect(recommendOrientation('a minimalist logo', FLUX)?.value).toBe('1:1');
      expect(recommendOrientation('a profile picture avatar', FLUX)?.value).toBe('1:1');
    });
  });

  describe('GPT-Image models (size)', () => {
    it('recommends the matching GPT size instead of an aspect ratio', () => {
      expect(recommendOrientation('A photorealistic portrait of a person', GPT)).toEqual({
        label: 'portrait',
        settingKey: 'size',
        value: '1024x1536',
      });
      expect(recommendOrientation('a sweeping mountain landscape', GPT)).toEqual({
        label: 'landscape',
        settingKey: 'size',
        value: '1536x1024',
      });
      expect(recommendOrientation('a minimalist logo', GPT)).toEqual({
        label: 'square',
        settingKey: 'size',
        value: '1024x1024',
      });
    });

    it('recognizes versioned GPT-Image ids (e.g. gpt-image-2 snapshots)', () => {
      expect(recommendOrientation('a portrait', 'gpt-image-2-2026-04-21')?.settingKey).toBe('size');
    });
  });

  it('returns null when nothing matches or the prompt is empty', () => {
    expect(recommendOrientation('a cat wearing a hat', FLUX)).toBeNull();
    expect(recommendOrientation('a cat wearing a hat', GPT)).toBeNull();
    expect(recommendOrientation('   ', FLUX)).toBeNull();
  });

  it('matches whole words only (no firing inside other words)', () => {
    expect(recommendOrientation('an iconic moment', FLUX)).toBeNull(); // 'icon' must not match 'iconic'
    expect(recommendOrientation('a deep understanding of physics', FLUX)).toBeNull(); // 'standing' not in 'understanding'
    expect(recommendOrientation('a tall lighthouse', FLUX)?.value).toBe('3:4'); // 'tall' as a real word still matches
  });
});
