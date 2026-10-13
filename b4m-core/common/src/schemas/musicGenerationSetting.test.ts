import { describe, expect, it } from 'vitest';
import { MusicGenerationSettingsSchema, settingsMap } from './settings';

describe('musicGeneration admin setting', () => {
  it('defaults to an empty override map', () => {
    expect(MusicGenerationSettingsSchema.parse({})).toEqual({ enabledModels: {} });
    expect(settingsMap.musicGeneration.defaultValue).toEqual({ enabledModels: {} });
  });
});
