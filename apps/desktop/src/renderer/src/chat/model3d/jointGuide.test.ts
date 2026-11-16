import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { JointGuide } from './jointGuide';
import type { JointDragFrame } from './jointDrag';

const lid: JointDragFrame = {
  motion: 'turn',
  pivot: new THREE.Vector3(0, 0, 0),
  axis: new THREE.Vector3(1, 0, 0),
  range: [0, 110],
  scale: 1,
};

/** Ticks the guide every 16 ms from `start` until it settles; how many frames that took. */
function runUntilSettled(guide: JointGuide, start: number): number {
  let frames = 0;
  while (guide.tick(start + frames * 16)) {
    frames += 1;
    if (frames > 200) throw new Error('The guide never settled.');
  }
  return frames;
}

describe('JointGuide', () => {
  it('draws a slide as one straight line after it showed an arc', () => {
    const guide = new JointGuide(() => false);
    guide.show(lid, 0, new THREE.Vector3(0, 0, 30), 50);
    const drawer: JointDragFrame = { ...lid, motion: 'slide', axis: new THREE.Vector3(0, -1, 0), range: [0, 40] };
    guide.show(drawer, 0, new THREE.Vector3(0, -20, 10), 50);
    const track = guide.object.children.find(child => child.type === 'Line') as THREE.Line;
    expect(track.geometry.getAttribute('position').count).toBe(2);
  });

  it('fades in when shown and settles, then fades out when hidden', () => {
    const guide = new JointGuide(() => false);
    guide.show(lid, 0, new THREE.Vector3(0, 0, 30), 40);
    expect(runUntilSettled(guide, 1000)).toBeGreaterThan(2);
    expect(guide.object.visible).toBe(true);
    guide.hide();
    expect(runUntilSettled(guide, 5000)).toBeGreaterThan(2);
    expect(guide.object.visible).toBe(false);
  });

  it('shows and hides at once under reduced motion', () => {
    const guide = new JointGuide(() => true);
    guide.show(lid, 0, new THREE.Vector3(0, 0, 30), 40);
    expect(guide.tick(0)).toBe(false);
    expect(guide.object.visible).toBe(true);
  });

  it('keeps animating while a limit flash warms it, then settles', () => {
    const guide = new JointGuide(() => false);
    guide.show(lid, 0, new THREE.Vector3(0, 0, 30), 40);
    runUntilSettled(guide, 0);
    guide.flash(10_000);
    expect(guide.tick(10_000)).toBe(true);
    expect(guide.tick(10_400)).toBe(false);
  });

  it('puts the dot on the arc at the joint value, about the pivot', () => {
    const guide = new JointGuide(() => true);
    guide.show(lid, 0, new THREE.Vector3(0, 0, 30), 40);
    guide.setValue(90);
    const dot = guide.object.children.find(child => child instanceof THREE.Mesh)!;
    // A quarter turn about +X carries +Z to -Y, at the part's distance from the hinge.
    expect(dot.position.x).toBeCloseTo(0, 6);
    expect(dot.position.y).toBeCloseTo(-30, 6);
    expect(dot.position.z).toBeCloseTo(0, 6);
  });
});
