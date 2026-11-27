import type { SkinTokens } from './mods';

/** The needs-you lamp. statePalette.ts uses it as that state's colour; no skin can change it. */
export const NEEDS_YOU_AMBER = '#f5c542';

/**
 * How far (CIE76 delta E, in Lab) a skin colour must sit from NEEDS_YOU_AMBER. Closer than this and it
 * reads as "needs you", so the merge drops it. 20 clears the built-in working orange (#ff9d3c, about 27)
 * and catches amber and gold variants such as #f0c050 (about 8) or #ffcc00 (about 17).
 */
export const NEEDS_YOU_MIN_DELTA_E = 20;

type Lab = readonly [number, number, number];

/** sRGB `#rrggbb` to linear-light [r, g, b]. */
function toLinear(hex: string): [number, number, number] {
  const linear = [1, 3, 5].map(offset => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return linear as [number, number, number];
}

/** sRGB `#rrggbb` to CIE Lab under D65. */
function toLab(hex: string): Lab {
  const [r, g, b] = toLinear(hex);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (value: number) => (value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = toLinear(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

export const looksLikeNeedsYou = (color: string): boolean => deltaE(color, NEEDS_YOU_AMBER) < NEEDS_YOU_MIN_DELTA_E;

/**
 * Token keys (`states.working`, `surfaces.card`) whose colour is too close to the needs-you amber. The
 * `needs-you` state itself is not listed: the merge drops it whatever its colour.
 */
export function needsYouLookalikeKeys(tokens: SkinTokens): string[] {
  const colors: [string, string | undefined][] = [
    ...Object.entries(tokens.states ?? {})
      .filter(([state]) => state !== 'needs-you')
      .map(([state, color]): [string, string | undefined] => [`states.${state}`, color]),
    ...Object.entries(tokens.surfaces ?? {}).map(([surface, color]): [string, string | undefined] => [
      `surfaces.${surface}`,
      color,
    ]),
  ];
  return colors.filter(([, color]) => color !== undefined && looksLikeNeedsYou(color)).map(([key]) => key);
}
