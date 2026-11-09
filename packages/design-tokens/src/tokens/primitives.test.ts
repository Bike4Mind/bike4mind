import { describe, expect, it } from 'vitest';
import { colorPrimitives, unique } from './primitives';

// The alpha tables are pre-materialized rgba() strings. This suite proves the
// derivation relationship still holds: every variant decomposes to its base
// ramp color at the opacity its key names.

const hexToRgb = (hex: string): [number, number, number] => {
  const normalized = hex.length === 4 ? `#${[...hex.slice(1)].map(c => c + c).join('')}` : hex;
  return [
    parseInt(normalized.slice(1, 3), 16),
    parseInt(normalized.slice(3, 5), 16),
    parseInt(normalized.slice(5, 7), 16),
  ];
};

const parseRgba = (value: string): { rgb: [number, number, number]; alpha: number } => {
  const match = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(value);
  if (!match) throw new Error(`not an rgba() string: ${value}`);
  return {
    rgb: [Number(match[1]), Number(match[2]), Number(match[3])],
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  };
};

// Alpha tables whose base is a fixed color rather than a ramp stop.
const FIXED_BASES: Record<string, string> = {
  'white.0': '#FFFFFF',
  'black.0': '#000000',
  'teal.custom': unique.tealPreview,
};

// Widened views for dynamic iteration (the concrete objects have literal keys).
const ramps: Record<string, Record<string, string>> = colorPrimitives.ramps;
const alphas: Record<string, Record<string, Record<string, string>>> = colorPrimitives.alphas;

describe('color primitives', () => {
  it('every alpha variant matches its base color and named opacity', () => {
    for (const [rampName, alphaRamp] of Object.entries(alphas)) {
      for (const [stop, variants] of Object.entries(alphaRamp)) {
        const base = FIXED_BASES[`${rampName}.${stop}`] ?? ramps[rampName]?.[stop];
        expect(base, `base color for ${rampName}[${stop}]`).toBeDefined();
        for (const [percent, value] of Object.entries(variants)) {
          const label = `${rampName}Alpha[${stop}][${percent}]`;
          if (value.startsWith('#')) {
            // Full-opacity variants stay the raw base hex.
            expect(Number(percent), label).toBe(100);
            expect(value.toLowerCase(), label).toBe(String(base).toLowerCase());
            continue;
          }
          const { rgb, alpha } = parseRgba(value);
          expect(rgb, label).toEqual(hexToRgb(String(base)));
          expect(alpha, label).toBeCloseTo(Number(percent) / 100, 10);
        }
      }
    }
  });

  it('ramps contain only hex colors', () => {
    for (const ramp of Object.values(ramps)) {
      for (const value of Object.values(ramp)) {
        expect(value).toMatch(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
      }
    }
  });
});
