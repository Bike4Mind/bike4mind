import type { PublicMusicModel } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { parseMusicModels, planMusicRequest } from './musicModels';

const base: PublicMusicModel = {
  id: 'lyria',
  object: 'music_model',
  display_name: 'Lyria',
  provider: 'google',
  vocals: 'optional',
  lyrics: null,
  duration: { control: 'approximate', min: 10, max: 180, default: 60 },
  output_formats: ['mp3'],
  typical_render_seconds: 60,
  pricing: { unit: 'per_song', credits: 10 },
  preview: false,
  deprecation_date: null,
};

describe('parseMusicModels', () => {
  it('keeps the models it can read and drops one it cannot', () => {
    expect(parseMusicModels({ models: [{ id: 'broken' }, base] }).map(model => model.id)).toEqual(['lyria']);
    expect(parseMusicModels(null)).toEqual([]);
    expect(parseMusicModels({ models: 'nope' })).toEqual([]);
  });
});

describe('planMusicRequest', () => {
  it('uses the model default length and a flat price per song', () => {
    expect(planMusicRequest(base, {})).toMatchObject({ effectiveSeconds: 60, estimatedCredits: 10 });
  });

  it('prices per second on the requested length', () => {
    const model = { ...base, pricing: { unit: 'per_second' as const, credits: 0.5 } };
    expect(planMusicRequest(model, { durationSeconds: 45 })).toMatchObject({
      effectiveSeconds: 45,
      estimatedCredits: 23,
    });
  });

  it('refuses a length outside the range', () => {
    expect(() => planMusicRequest(base, { durationSeconds: 5 })).toThrow(/10-180s/);
    expect(() => planMusicRequest(base, { durationSeconds: 181 })).toThrow(/10-180s/);
    expect(planMusicRequest(base, { durationSeconds: 10 }).effectiveSeconds).toBe(10);
  });

  it('accepts only the fixed length on a fixed model', () => {
    const fixed = { ...base, duration: { control: 'fixed' as const, seconds: 30 } };
    expect(planMusicRequest(fixed, {}).effectiveSeconds).toBe(30);
    expect(planMusicRequest(fixed, { durationSeconds: 30 }).effectiveSeconds).toBe(30);
    expect(() => planMusicRequest(fixed, { durationSeconds: 31 })).toThrow(/always makes 30s/);
  });

  it('refuses vocals on an instrumental-only model', () => {
    const never = { ...base, vocals: 'never' as const };
    expect(() => planMusicRequest(never, { instrumental: false })).toThrow(/only makes instrumental/);
    expect(planMusicRequest(never, { instrumental: true }).model.id).toBe('lyria');
    expect(planMusicRequest(never, {}).model.id).toBe('lyria');
  });
});
