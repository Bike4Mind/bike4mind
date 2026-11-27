import { describe, expect, it } from 'vitest';
import {
  STUDIO_FULL_FRAME_CROP,
  studioClipCropFor,
  studioCropFfmpegFilter,
  studioCropRegion,
  studioCropShownRect,
} from './crop';
import type { StudioCropRect } from './timeline';

const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };
const SQUARE = { width: 1080, height: 1080 };

/** Evaluates the filter the way ffmpeg's crop does: w and h from iw/ih first, then x and y from ow/oh too. */
const evaluateFfmpegCrop = (filter: string, source: { width: number; height: number }) => {
  const options = Object.fromEntries(
    [...filter.matchAll(/(\w)='([^']*)'/g)].map(([, key, expression]) => [key, expression])
  );
  const evaluate = (expression: string, variables: Record<string, number>): number => {
    const body = Object.entries(variables).reduce(
      (text, [name, value]) => text.replaceAll(new RegExp(`\\b${name}\\b`, 'g'), String(value)),
      expression.replaceAll('min(', 'Math.min(')
    );
    // Test-only: the expression is built from numbers and the four variables above, nothing user supplied.
    return Number(new Function(`return ${body};`)());
  };
  const sizes = { iw: source.width, ih: source.height };
  const width = evaluate(options.w, sizes);
  const height = evaluate(options.h, sizes);
  const placed = { ...sizes, ow: width, oh: height };
  return { x: evaluate(options.x, placed), y: evaluate(options.y, placed), width, height };
};

describe('studioCropRegion', () => {
  it('centre crops with the whole-frame rect, as the cover fit always did', () => {
    expect(studioCropRegion(STUDIO_FULL_FRAME_CROP, LANDSCAPE, PORTRAIT)).toEqual({
      x: (1920 - 607.5) / 2,
      y: 0,
      width: 607.5,
      height: 1080,
    });
    expect(studioCropRegion(STUDIO_FULL_FRAME_CROP, PORTRAIT, LANDSCAPE)).toEqual({
      x: 0,
      y: (1920 - 607.5) / 2,
      width: 1080,
      height: 607.5,
    });
  });

  it('shows the whole source when the shapes already match', () => {
    expect(studioCropRegion(STUDIO_FULL_FRAME_CROP, LANDSCAPE, { width: 1280, height: 720 })).toEqual({
      x: 0,
      y: 0,
      ...LANDSCAPE,
    });
  });

  it('frames a rect of the output shape exactly', () => {
    const rect: StudioCropRect = { x: 0, y: 0, width: 607.5 / 1920, height: 1 };
    expect(studioCropRegion(rect, LANDSCAPE, PORTRAIT)).toEqual({ x: 0, y: 0, width: 607.5, height: 1080 });
  });

  it('centres the output shape inside a rect of another shape', () => {
    const region = studioCropRegion({ x: 0.5, y: 0, width: 0.5, height: 1 }, LANDSCAPE, SQUARE);
    expect(region).toEqual({ x: 960 + (960 - 960) / 2, y: (1080 - 960) / 2, width: 960, height: 960 });
  });
});

describe('studioCropShownRect', () => {
  it('normalizes the shown region', () => {
    expect(studioCropShownRect(STUDIO_FULL_FRAME_CROP, LANDSCAPE, SQUARE)).toEqual({
      x: 0.21875,
      y: 0,
      width: 0.5625,
      height: 1,
    });
  });
});

describe('studioCropFfmpegFilter', () => {
  const rects: StudioCropRect[] = [
    STUDIO_FULL_FRAME_CROP,
    { x: 0.1, y: 0, width: 0.316406, height: 1 },
    { x: 0.5, y: 0.2, width: 0.4, height: 0.7 },
    { x: 0, y: 0.25, width: 1, height: 0.3 },
  ];
  const sources = [LANDSCAPE, PORTRAIT, SQUARE, { width: 3840, height: 1634 }];
  const outputs = [LANDSCAPE, PORTRAIT, SQUARE, { width: 1080, height: 1350 }];

  it('quotes its expressions so the commas survive a filter graph', () => {
    expect(studioCropFfmpegFilter({ x: 0.25, y: 0, width: 0.5, height: 1 }, PORTRAIT)).toBe(
      "crop=w='min(0.5*iw,1*ih*1080/1920)':h='min(1*ih,0.5*iw*1920/1080)':x='0.25*iw+(0.5*iw-ow)/2':y='0*ih+(1*ih-oh)/2'"
    );
  });

  it.each(rects.flatMap(rect => sources.flatMap(source => outputs.map(output => ({ rect, source, output })))))(
    'matches studioCropRegion for $rect on $source into $output',
    ({ rect, source, output }) => {
      const fromFfmpeg = evaluateFfmpegCrop(studioCropFfmpegFilter(rect, output), source);
      const fromPreview = studioCropRegion(rect, source, output);
      for (const key of ['x', 'y', 'width', 'height'] as const)
        expect(fromFfmpeg[key]).toBeCloseTo(fromPreview[key], 2);
    }
  );
});

describe('studioClipCropFor', () => {
  const rect: StudioCropRect = { x: 0.2, y: 0, width: 0.3, height: 1 };

  it('returns the rect for the aspect ratio on a cover clip', () => {
    expect(studioClipCropFor({ fit: 'cover', crop: { '9:16': rect } }, '9:16')).toBe(rect);
    expect(studioClipCropFor({ fit: 'cover', crop: { '9:16': rect } }, '1:1')).toBeUndefined();
    expect(studioClipCropFor({ fit: 'cover' }, '9:16')).toBeUndefined();
  });

  it('ignores the rect on a contain clip', () => {
    expect(studioClipCropFor({ fit: 'contain', crop: { '9:16': rect } }, '9:16')).toBeUndefined();
  });
});
