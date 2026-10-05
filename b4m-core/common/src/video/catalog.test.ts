import { describe, expect, it } from 'vitest';
import { VIDEO_MODEL_CATALOG, VIDEO_MODEL_IDS } from './catalog';
import { validateAgainstCapabilities } from './validate';
import { estimateVideoCostUsd } from './estimateCost';

// Guards every future declaration: a model must accept its own defaults and price every
// resolution/duration it declares, or the studio would offer an option the server rejects.
describe.each(VIDEO_MODEL_IDS)('catalog entry %s', id => {
  const caps = VIDEO_MODEL_CATALOG[id];

  it('accepts its own defaults', () => {
    const result = validateAgainstCapabilities(
      { model: id, mode: 'text_to_video', prompt: 'p', ...caps.defaults },
      caps.modes.includes('text_to_video') ? caps : { ...caps, modes: [...caps.modes, 'text_to_video'] }
    );
    expect(result.ok).toBe(true);
  });

  it('prices every declared resolution at its default duration', () => {
    for (const resolution of caps.resolutions) {
      const usd = estimateVideoCostUsd(caps, {
        model: id,
        mode: 'text_to_video',
        prompt: 'p',
        ...caps.defaults,
        resolution,
      });
      expect(usd).toBeGreaterThan(0);
    }
  });
});
