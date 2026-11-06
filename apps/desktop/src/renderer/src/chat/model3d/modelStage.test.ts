// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { toneMapped, untoneMapped } from './modelStage';

describe('untoneMapped', () => {
  it.each(['#f4f5f7', '#1b1e23', '#808080'])('comes back out of the tone mapping as %s', hex => {
    const shown = toneMapped(untoneMapped(hex));
    expect(`#${shown.getHexString(THREE.SRGBColorSpace)}`).toBe(hex);
  });

  it('needs a brighter-than-white input for a near-white backdrop, which a plain hex cannot give', () => {
    expect(untoneMapped('#f4f5f7').r).toBeGreaterThan(1);
  });
});
