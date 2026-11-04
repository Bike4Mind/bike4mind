import { describe, expect, it } from 'vitest';
import { swingAngles } from './ModelJoints';

describe('swingAngles', () => {
  const joints = [
    { name: 'lid', axis: [1, 0, 0] as [number, number, number], range: [0, 110] as [number, number] },
    { name: 'door', axis: [0, 0, 1] as [number, number, number], range: [10, -80] as [number, number] },
  ];

  it('starts closed, is fully open half way through and closes again', () => {
    expect(swingAngles(joints, 0)).toEqual({ lid: 0, door: 10 });
    expect(swingAngles(joints, 0.5).lid).toBeCloseTo(110);
    expect(swingAngles(joints, 0.5).door).toBeCloseTo(-80);
    expect(swingAngles(joints, 0.25).lid).toBeCloseTo(55);
    expect(swingAngles(joints, 1).lid).toBeCloseTo(0);
  });
});
