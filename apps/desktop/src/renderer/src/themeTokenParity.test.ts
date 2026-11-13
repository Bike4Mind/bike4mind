import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/desktopThemeBefore.json';
import { desktopTheme } from './theme';

// Pins what the desktop theme renders. The fixture was captured from the hand-written theme
// before it was derived from @bike4mind/design-tokens, so a green run proves the switch changed
// no color or metric. If a value changes on purpose, regenerate the fixture in the same PR and say
// so: temporarily replace `expect(snapshot()).toEqual(fixture)` below with
// `console.log(JSON.stringify(snapshot(), null, 2))`, run this file with
// `pnpm --filter @bike4mind/desktop exec vitest run src/renderer/src/themeTokenParity.test.ts`,
// paste the output over __fixtures__/desktopThemeBefore.json, and restore the assertion.

const COLOR = /^(?:#([0-9a-f]{6})|rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[,/]\s*([\d.]+))?\s*\))$/i;

// Hex, rgb() and rgba() (comma or slash syntax) all become [r, g, b, a], so a notation change
// is not drift but a changed channel is.
const normalizeColors = (value: unknown): unknown => {
  if (typeof value === 'string') {
    const m = COLOR.exec(value.trim());
    if (!m) return value;
    if (m[1]) return [0, 2, 4].map(i => Number.parseInt(m[1].slice(i, i + 2), 16)).concat(1);
    return [Number(m[2]), Number(m[3]), Number(m[4]), m[5] === undefined ? 1 : Number(m[5])];
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeColors(v)]));
  }
  return value;
};

const snapshot = () =>
  JSON.parse(
    JSON.stringify(
      normalizeColors({
        light: desktopTheme.colorSchemes.light.palette,
        dark: desktopTheme.colorSchemes.dark.palette,
        fontFamily: desktopTheme.fontFamily,
        fontSize: desktopTheme.fontSize,
        fontWeight: desktopTheme.fontWeight,
        lineHeight: desktopTheme.lineHeight,
        radius: desktopTheme.radius,
        shadow: desktopTheme.shadow,
        spacing: desktopTheme.spacing(1),
      })
    )
  ) as Record<string, unknown>;

describe('desktop theme parity', () => {
  it('renders the same palette and metrics as the pre-token theme', () => {
    expect(snapshot()).toEqual(fixture);
  });
});
