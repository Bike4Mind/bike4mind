import { describe, expect, it } from 'vitest';
import { strokesToMaskPixels } from './maskImage';

describe('strokesToMaskPixels', () => {
  it('paints stroked pixels white and the rest black, all opaque', () => {
    const strokes = new Uint8ClampedArray([255, 0, 128, 40, 0, 0, 0, 0]);
    expect([...strokesToMaskPixels(strokes)]).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
  });
});
