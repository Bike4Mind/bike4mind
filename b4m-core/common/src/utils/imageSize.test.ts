import { describe, it, expect } from 'vitest';
import { BFL_DIMENSION_BOUNDS, parseImageSize, resolveImageDimensions } from './imageSize';

describe('parseImageSize', () => {
  it('parses a WIDTHxHEIGHT preset', () => {
    expect(parseImageSize('1440x810')).toEqual({ width: 1440, height: 810 });
    expect(parseImageSize(' 512x512 ')).toEqual({ width: 512, height: 512 });
  });

  it('returns undefined for values that are not two positive integers', () => {
    for (const value of ['', 'auto', '1024', '1024x', 'x768', '0x768', '1024x0', '1024X768', '10.5x20', null, undefined]) {
      expect(parseImageSize(value)).toBeUndefined();
    }
  });
});

describe('resolveImageDimensions', () => {
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
    expect(resolveImageDimensions({ size: '1440x810' }, BFL_DIMENSION_BOUNDS)).toEqual({ width: 1440, height: 810 });
  });

  it('keeps an out-of-range preset when no bounds are supplied', () => {
    expect(resolveImageDimensions({ size: '3840x2160' })).toEqual({ width: 3840, height: 2160 });
  });

  it('yields nothing when there is neither an explicit dimension nor a parseable preset', () => {
    expect(resolveImageDimensions({ size: 'auto' })).toEqual({ width: undefined, height: undefined });
  });
});
