import { describe, expect, it } from 'vitest';
import type { ModelJoint } from '@shared/model3d';
import { jointReadout, swingAngles } from './ModelJoints';

const lid: ModelJoint = { name: 'lid', motion: 'turn', axis: [1, 0, 0], range: [0, 110] };
const door: ModelJoint = { name: 'door', motion: 'turn', axis: [0, 0, 1], range: [10, -80] };

describe('swingAngles', () => {
  it('starts closed, is fully open half way through and closes again', () => {
    const joints = [lid, door];
    expect(swingAngles(joints, 0)).toEqual({ lid: 0, door: 10 });
    expect(swingAngles(joints, 0.5).lid).toBeCloseTo(110);
    expect(swingAngles(joints, 0.5).door).toBeCloseTo(-80);
    expect(swingAngles(joints, 0.25).lid).toBeCloseTo(55);
    expect(swingAngles(joints, 1).lid).toBeCloseTo(0);
  });
});

describe('jointReadout', () => {
  it('shows whole degrees for a turn and a distance for a slide', () => {
    expect(jointReadout(lid, 54.6, 'mm')).toBe('55\u00b0');
    expect(jointReadout({ ...lid, motion: 'slide', range: [0, 40] }, 12.4, 'mm')).toBe('12 mm');
    expect(jointReadout({ ...lid, motion: 'slide', range: [0, 0.04] }, 0.0124, 'm')).toBe('0.012 m');
  });
});
