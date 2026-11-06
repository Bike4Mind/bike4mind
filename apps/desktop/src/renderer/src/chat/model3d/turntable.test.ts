import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ModelJoint } from '@shared/model3d';
import { orbitPosition, swing, turntableMimeType, turntablePose } from './turntable';

const lid: ModelJoint = { name: 'lid', motion: 'turn', axis: [1, 0, 0], range: [0, 100] };
const drawer: ModelJoint = { name: 'drawer', motion: 'slide', axis: [0, 0, 1], range: [-20, 0] };

describe('swing', () => {
  it('starts and ends at rest and peaks halfway, so the clip loops', () => {
    expect(swing(0)).toBeCloseTo(0);
    expect(swing(0.5)).toBeCloseTo(1);
    expect(swing(1)).toBeCloseTo(0);
    expect(swing(-1)).toBeCloseTo(0);
  });
});

describe('turntablePose', () => {
  it('swings each joint from where it was left to its far end and back', () => {
    expect(turntablePose([lid, drawer], { lid: 0, drawer: 0 }, 0)).toEqual({ lid: 0, drawer: 0 });
    const peak = turntablePose([lid, drawer], { lid: 0, drawer: 0 }, 0.5);
    expect(peak.lid).toBeCloseTo(100);
    expect(peak.drawer).toBeCloseTo(-20);
  });

  it('swings a joint left near its top end back towards the bottom', () => {
    expect(turntablePose([lid], { lid: 90 }, 0.5).lid).toBeCloseTo(0);
  });

  it('clamps a start outside the range and treats a missing one as 0', () => {
    expect(turntablePose([lid], { lid: 400 }, 0).lid).toBe(100);
    expect(turntablePose([drawer], {}, 0).drawer).toBe(0);
  });
});

describe('orbitPosition', () => {
  const target = new THREE.Vector3(1, 2, 3);
  const start = new THREE.Vector3(1, 5, 13);

  it('keeps the height and the distance from the target', () => {
    const quarter = orbitPosition(start, target, 0.25);
    expect(quarter.y).toBeCloseTo(5);
    expect(quarter.distanceTo(target)).toBeCloseTo(start.distanceTo(target));
    expect(quarter.x).toBeCloseTo(11);
  });

  it('comes back to where it started after one turn', () => {
    const end = orbitPosition(start, target, 1);
    expect(end.distanceTo(start)).toBeCloseTo(0);
  });
});

describe('turntableMimeType', () => {
  it('prefers VP9 and falls back to plain WebM', () => {
    expect(turntableMimeType(() => true)).toBe('video/webm;codecs=vp9');
    expect(turntableMimeType(type => type === 'video/webm')).toBe('video/webm');
    expect(turntableMimeType(() => false)).toBeNull();
  });
});
