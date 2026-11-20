import { describe, expect, it } from 'vitest';
import { avatarDetailsPosition } from './useAvatarDetailsPosition';

describe('avatarDetailsPosition', () => {
  const scene = { width: 1000, height: 600 };
  const panel = { width: 320, height: 300 };

  it('opens beside the avatar with a small gap', () => {
    expect(avatarDetailsPosition(scene, { left: 100, right: 160, top: 100 }, panel)).toEqual({ left: 172, top: 100 });
  });

  it('flips left at the right edge and clamps at the floor', () => {
    expect(avatarDetailsPosition(scene, { left: 900, right: 960, top: 500 }, panel)).toEqual({ left: 568, top: 288 });
  });

  it('clamps a scene-width panel and an avatar beyond the top edge', () => {
    expect(
      avatarDetailsPosition(
        { width: 280, height: 200 },
        { left: 100, right: 160, top: -20 },
        { width: 256, height: 176 }
      )
    ).toEqual({ left: 12, top: 12 });
  });

  it('repositions for a newly selected avatar', () => {
    const first = avatarDetailsPosition(scene, { left: 100, right: 160, top: 100 }, panel);
    const second = avatarDetailsPosition(scene, { left: 700, right: 760, top: 200 }, panel);
    expect(second).toEqual({ left: 368, top: 200 });
    expect(second).not.toEqual(first);
  });
});
