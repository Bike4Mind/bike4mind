import { describe, it, expect } from 'vitest';
import { BFL_DIMENSION_BOUNDS, parseImageSize, resolveImageDimensions } from './imageSize';

describe('parseImageSize', () => {
  it('parses a WIDTHxHEIGHT preset', () => {
    expect(parseImageSize('1440x810')).toEqual({ width: 1440, height: 810 });
    expect(parseImageSize(' 512x512 ')).toEqual({ width: 512, height: 512 });
  });

  it('returns undefined for values that are not two positive integers', () => {
    for (const value of [
      '',
      'auto',
      '1024',
      '1024x',
      'x768',
      '0x768',
      '1024x0',
      '1024X768',
      '10.5x20',
      null,
      undefined,
    ]) {
      expect(parseImageSize(value)).toBeUndefined();
    }
  });
});

describe('resolveImageDimensions', () => {
  it('clamps a lone explicit dimension into bounds after snapping', () => {
    expect(resolveImageDimensions({ width: 10 }, BFL_DIMENSION_BOUNDS).width).toBe(256);
    expect(resolveImageDimensions({ width: 1460 }, BFL_DIMENSION_BOUNDS).width).toBe(1440);
  });

  it('scales an out-of-range explicit pair as a unit so its aspect ratio survives', () => {
    expect(resolveImageDimensions({ width: 2048, height: 1024 }, BFL_DIMENSION_BOUNDS)).toEqual({
      width: 1440,
      height: 736,
    });
    expect(resolveImageDimensions({ width: 1024, height: 2048 }, BFL_DIMENSION_BOUNDS)).toEqual({
      width: 736,
      height: 1440,
    });
    expect(resolveImageDimensions({ width: 128, height: 192 }, BFL_DIMENSION_BOUNDS)).toEqual({
      width: 256,
      height: 384,
    });
  });

  it('clamps each axis only when the ratio is wider than the bounds allow', () => {
    expect(resolveImageDimensions({ width: 4000, height: 400 }, BFL_DIMENSION_BOUNDS)).toEqual({
      width: 1440,
      height: 256,
    });
  });

  it('prefers explicit dimensions over the preset', () => {
    expect(resolveImageDimensions({ width: 800, height: 600, size: '1440x810' })).toEqual({ width: 800, height: 600 });
  });

  it('falls back to the preset when a dimension is missing', () => {
    expect(resolveImageDimensions({ size: '1440x810' })).toEqual({ width: 1440, height: 810 });
    expect(resolveImageDimensions({ width: 800, size: '1440x810' })).toEqual({ width: 800, height: 810 });
  });

  it('discards a preset the provider would reject rather than forwarding it', () => {
    expect(resolveImageDimensions({ size: '3840x2160' }, BFL_DIMENSION_BOUNDS)).toEqual({
      width: undefined,
      height: undefined,
    });
    expect(resolveImageDimensions({ size: '1792x1024' }, BFL_DIMENSION_BOUNDS)).toEqual({
      width: undefined,
      height: undefined,
    });
    expect(resolveImageDimensions({ size: '1440x810' }, BFL_DIMENSION_BOUNDS)).toEqual({ width: 1440, height: 800 });
  });

  it('rounds each dimension to the nearest multiple of the bounds step', () => {
    expect(resolveImageDimensions({ size: '1280x720' }, BFL_DIMENSION_BOUNDS)).toEqual({ width: 1280, height: 736 });
    expect(resolveImageDimensions({ size: '600x800' }, BFL_DIMENSION_BOUNDS)).toEqual({ width: 608, height: 800 });
    expect(resolveImageDimensions({ width: 1000, height: 1001 }, BFL_DIMENSION_BOUNDS)).toEqual({
      width: 992,
      height: 992,
    });
  });

  it('keeps the range edges on the grid', () => {
    const { min, max } = BFL_DIMENSION_BOUNDS;
    expect(resolveImageDimensions({ size: `${min}x${max}` }, BFL_DIMENSION_BOUNDS)).toEqual({
      width: min,
      height: max,
    });
  });

  it('does not round when the bounds carry no step', () => {
    expect(resolveImageDimensions({ size: '1440x810' }, { min: 256, max: 1440 })).toEqual({ width: 1440, height: 810 });
  });

  it('keeps an out-of-range preset when no bounds are supplied', () => {
    expect(resolveImageDimensions({ size: '3840x2160' })).toEqual({ width: 3840, height: 2160 });
  });

  it('yields nothing when there is neither an explicit dimension nor a parseable preset', () => {
    expect(resolveImageDimensions({ size: 'auto' })).toEqual({ width: undefined, height: undefined });
  });
});
