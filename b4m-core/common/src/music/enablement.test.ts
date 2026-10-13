import { describe, expect, it } from 'vitest';
import { MUSIC_MODEL_CATALOG } from './catalog';
import { isMusicModelEnabled } from './enablement';

describe('isMusicModelEnabled', () => {
  it('falls back to the catalog default when no override exists', () => {
    expect(isMusicModelEnabled('lyria-3.5', undefined)).toBe(MUSIC_MODEL_CATALOG['lyria-3.5'].defaultEnabled);
    expect(isMusicModelEnabled('lyria-3.5', { enabledModels: {} })).toBe(
      MUSIC_MODEL_CATALOG['lyria-3.5'].defaultEnabled
    );
  });

  it('an override wins over the catalog default', () => {
    expect(isMusicModelEnabled('lyria-3.5', { enabledModels: { 'lyria-3.5': false } })).toBe(false);
  });
});
