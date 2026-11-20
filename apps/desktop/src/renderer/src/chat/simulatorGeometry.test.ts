import { describe, expect, it } from 'vitest';
import { toDevicePoints, type DrawnFrame } from './simulatorGeometry';

const SCREEN = { width: 402, height: 874 };
const PORTRAIT: DrawnFrame = { left: 100, top: 50, width: 201, height: 437, naturalWidth: 402, naturalHeight: 874 };
const LANDSCAPE: DrawnFrame = { left: 0, top: 0, width: 437, height: 201, naturalWidth: 874, naturalHeight: 402 };

describe('toDevicePoints', () => {
  it('maps a pointer over a portrait frame to device points', () => {
    expect(toDevicePoints(100, 50, PORTRAIT, SCREEN)).toEqual({ x: 0, y: 0 });
    expect(toDevicePoints(200.5, 268.5, PORTRAIT, SCREEN)).toEqual({ x: 201, y: 437 });
    expect(toDevicePoints(301, 487, PORTRAIT, SCREEN)).toEqual({ x: 402, y: 874 });
  });

  it('returns null outside the frame', () => {
    expect(toDevicePoints(99, 100, PORTRAIT, SCREEN)).toBeNull();
    expect(toDevicePoints(150, 488, PORTRAIT, SCREEN)).toBeNull();
    expect(toDevicePoints(302, 100, PORTRAIT, SCREEN)).toBeNull();
  });

  it('returns null for a frame with no size yet', () => {
    expect(toDevicePoints(0, 0, { ...PORTRAIT, width: 0 }, SCREEN)).toBeNull();
  });

  it('swaps the screen sides when the frame is landscape', () => {
    expect(toDevicePoints(437, 201, LANDSCAPE, SCREEN)).toEqual({ x: 874, y: 402 });
    expect(toDevicePoints(218.5, 100.5, LANDSCAPE, SCREEN)).toEqual({ x: 437, y: 201 });
  });

  it('is indifferent to which way round the screen is given', () => {
    expect(toDevicePoints(437, 201, LANDSCAPE, { width: 874, height: 402 })).toEqual({ x: 874, y: 402 });
  });
});
