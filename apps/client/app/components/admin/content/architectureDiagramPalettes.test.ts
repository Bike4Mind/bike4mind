import { describe, expect, it } from 'vitest';
import { DARK_PALETTE, LIGHT_PALETTE, type DiagramPalette } from './architectureDiagramPalettes';

const AA_TEXT = 4.5;

// Same WCAG 2 math as app/utils/themes/contrast.test.ts.
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => {
    const s = parseInt(hex.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

type Pair = { name: string; fg: string; bg: string };

/**
 * Every text color the diagrams draw, on every fill it can sit on. Body text and sublabels are
 * checked against all panel fills (a superset of where they land), accent labels against their own box.
 */
const textPairs = (palette: DiagramPalette): Pair[] => {
  const surfaces = [
    'bg',
    'panel',
    'vpc',
    ...Object.keys(palette).filter(k => k.endsWith('Light') && k !== 'textLight'),
  ];
  const fill = (key: string) => palette[key as keyof DiagramPalette] as string;
  return [
    ...(['text', 'textLight'] as const).flatMap(fg =>
      surfaces.map(bg => ({ name: `${fg} on ${bg}`, fg: palette[fg], bg: fill(bg) }))
    ),
    { name: 'apiGw on apiGwLight', fg: palette.apiGw, bg: palette.apiGwLight },
    { name: 'vpcBorder on vpc', fg: palette.vpcBorder, bg: palette.vpc },
    { name: 'mongo on mongoLight', fg: palette.mongo, bg: palette.mongoLight },
    { name: 'onAccent on mongoSolid', fg: palette.onAccent, bg: palette.mongoSolid },
    ...palette.securityLayers.flatMap((layer, index) => [
      { name: `security layer ${index + 1} label`, fg: layer.stroke, bg: layer.fill },
      { name: `security layer ${index + 1} text`, fg: palette.text, bg: layer.fill },
    ]),
  ];
};

/*
 * The light palette is the original diagram colors, kept as they were on purpose; these pairs were already
 * under 4.5:1 there. Each floor is today's ratio truncated to two decimals, so an edit can raise a pair but not lower it,
 * and a pair that is not listed has to pass.
 */
const LIGHT_KNOWN_LOW: Record<string, number> = {
  'textLight on vpc': 4.43,
  'textLight on awsLight': 4.33,
  'textLight on lambdaLight': 4.27,
  'textLight on sqsLight': 4.09,
  'textLight on s3Light': 3.9,
  'textLight on apiGwLight': 4,
  'textLight on ecsLight': 4.48,
  'textLight on cloudfrontLight': 4.33,
  'textLight on secretsLight': 4.25,
  'textLight on eventBridgeLight': 4.04,
  'textLight on mongoLight': 4.23,
  'textLight on clientLight': 4.14,
  'textLight on securityLight': 3.89,
  'textLight on aiLight': 4,
  'textLight on vectorLight': 4.25,
  'textLight on embedLight': 4.22,
  'apiGw on apiGwLight': 3.56,
  'vpcBorder on vpc': 2.73,
  'security layer 3 label': 3.33,
  'security layer 4 label': 1.98,
  'security layer 5 label': 1.74,
  'security layer 6 label': 1.71,
  'security layer 6 text': 3.88,
  'security layer 7 label': 1.72,
  'security layer 7 text': 3.02,
  'security layer 8 label': 1.54,
  'security layer 8 text': 2.26,
};

const flatten = (value: unknown, path = ''): [string, string][] =>
  typeof value === 'string'
    ? [[path, value.toUpperCase()]]
    : Object.entries(value as object).flatMap(([key, inner]) => flatten(inner, path ? `${path}.${key}` : key));

// White text on the filled pill and the drop shadow read the same on both canvases.
const SHARED_KEYS = ['onAccent', 'shadow'];

describe('architecture diagram palettes', () => {
  it('gives every dark color its own value, so no light fill leaks into dark mode', () => {
    const light = Object.fromEntries(flatten(LIGHT_PALETTE));
    const same = flatten(DARK_PALETTE)
      .filter(([key, hex]) => hex === light[key])
      .map(([key]) => key);
    expect(same).toEqual(SHARED_KEYS);
  });

  it('checks the same set of pairs in both palettes', () => {
    expect(textPairs(DARK_PALETTE).map(pair => pair.name)).toEqual(textPairs(LIGHT_PALETTE).map(pair => pair.name));
    expect(textPairs(DARK_PALETTE)).toHaveLength(56);
  });

  it.each(textPairs(DARK_PALETTE))('dark: $name reaches 4.5:1', ({ fg, bg }) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it.each(textPairs(LIGHT_PALETTE))(
    'light: $name reaches 4.5:1 or does not drop below its known floor',
    ({ name, fg, bg }) => {
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(LIGHT_KNOWN_LOW[name] ?? AA_TEXT);
    }
  );
});
