import { describe, expect, it } from 'vitest';
import { StudioCropRectSchema } from '@bike4mind/common';
import { moveCropRect, resizeCropRect } from './cropEdits';

// A 9:16 box on a 16:9 source: normalized height = width * (16/9) / (9/16).
const TALL_ON_WIDE = 16 / 9 / (9 / 16);
const tall = { x: 0.3, y: 0, width: 1 / TALL_ON_WIDE, height: 1 };

describe('moveCropRect', () => {
  it('slides the rect and stops at the frame edges', () => {
    expect(moveCropRect(tall, 0.1, 0)).toEqual({ ...tall, x: 0.4 });
    expect(moveCropRect(tall, -1, 0).x).toBe(0);
    expect(moveCropRect(tall, 1, 0).x).toBeCloseTo(1 - tall.width);
    expect(moveCropRect(tall, 0, 0.2).y).toBe(0);
  });
});

describe('resizeCropRect', () => {
  const half = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };

  it('keeps the opposite corner pinned and the output shape', () => {
    const grown = resizeCropRect(half, 'se', 0.1, 0, 1);
    expect(grown).toEqual({ x: 0.25, y: 0.25, width: 0.6, height: 0.6 });
    const shrunk = resizeCropRect(half, 'nw', 0.1, 0, 1);
    expect(shrunk.x + shrunk.width).toBeCloseTo(0.75);
    expect(shrunk.y + shrunk.height).toBeCloseTo(0.75);
    expect(shrunk.width).toBeCloseTo(0.4);
  });

  it('lets a mostly vertical drag resize the box', () => {
    expect(resizeCropRect(half, 'se', 0, 0.2, 1).width).toBeCloseTo(0.7);
  });

  it('stops at the frame edge on either axis', () => {
    const shrunk = { x: 0.3, y: 0.2, width: 0.1, height: 0.1 * TALL_ON_WIDE };
    const grown = resizeCropRect(shrunk, 'se', 1, 1, TALL_ON_WIDE);
    expect(grown.y + grown.height).toBeCloseTo(1);
    expect(StudioCropRectSchema.safeParse(grown).success).toBe(true);
  });

  it('never shrinks below the minimum edge', () => {
    const smallest = resizeCropRect(tall, 'ne', -1, 0, TALL_ON_WIDE);
    expect(smallest.width).toBeCloseTo(0.05);
    expect(StudioCropRectSchema.safeParse(smallest).success).toBe(true);
  });
});
