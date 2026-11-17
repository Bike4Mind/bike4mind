import { describe, expect, it } from 'vitest';
import { hasPaintedPixels, strokesToMaskPixels } from './maskImage';

describe('strokesToMaskPixels', () => {
  it('paints stroked pixels white and the rest black, all opaque', () => {
    const strokes = new Uint8ClampedArray([255, 0, 128, 40, 0, 0, 0, 0]);
    expect([...strokesToMaskPixels(strokes)]).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
  });
});

describe('hasPaintedPixels', () => {
  it('is false for an untouched layer and true once any pixel has alpha', () => {
    expect(hasPaintedPixels(new Uint8ClampedArray(8))).toBe(false);
    expect(hasPaintedPixels(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 1]))).toBe(true);
  });
});
