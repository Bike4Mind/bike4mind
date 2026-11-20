// @vitest-environment node
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { extendTheme } from '@mui/joy/styles';
import { designTokens } from '@bike4mind/design-tokens';
import { getThemeConfig } from './themePrimitives';

// The proof of the no-visual-change claim for the design-tokens extraction:
// the theme config the app builds from the token package must equal, value for
// value, the config the pre-refactor hand-written theme produced. The fixture
// is that pre-refactor output, captured verbatim. If a token value changes on
// purpose, regenerate the fixture in the same PR and say so.
const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/preRefactorThemeConfig.json', import.meta.url), 'utf8')
) as Record<string, unknown>;

describe('design token parity', () => {
  it('produces the exact pre-refactor theme config', () => {
    const config = getThemeConfig();
    const emitted = JSON.parse(
      JSON.stringify({
        colorSchemes: config.colorSchemes,
        fontFamily: config.fontFamily,
        borderRadius: config.borderRadius,
      })
    ) as Record<string, unknown>;
    expect(emitted).toEqual(fixture);
  });

  it('emits metrics that resolve to Joy defaults (no visual change) and to the tokens', () => {
    // The theme now sets these slots from the tokens. They were pinned to
    // Joy's defaults, so the emitted theme must still equal a theme that sets
    // none of them; and both must equal the tokens, or the tokens no longer
    // describe what the web app renders.
    const theme = extendTheme(getThemeConfig() as Parameters<typeof extendTheme>[0]);
    const joyDefaults = extendTheme({});
    for (const slot of ['fontSize', 'fontWeight', 'lineHeight', 'radius', 'shadow'] as const) {
      expect(theme[slot]).toEqual(joyDefaults[slot]);
    }
    for (const n of [0.5, 1, 2, 3, 4]) {
      expect(theme.spacing(n)).toBe(joyDefaults.spacing(n));
    }
    expect(theme.fontSize).toEqual(designTokens.typography.fontSize);
    expect(theme.fontWeight).toEqual(designTokens.typography.fontWeight);
    expect(theme.lineHeight).toEqual(designTokens.typography.lineHeight);
    expect(theme.fontFamily.body).toBe(designTokens.typography.fontFamily.body);
    expect(theme.fontFamily.display).toBe(designTokens.typography.fontFamily.display);
    expect(theme.spacing(1)).toBe(`${designTokens.spacing.unit}px`);
    expect(theme.radius).toEqual(
      Object.fromEntries(Object.entries(designTokens.radii).map(([name, px]) => [name, `${px}px`]))
    );
    expect(Object.keys(theme.shadow)).toEqual(Object.keys(designTokens.shadows.levels));
  });

  it('passes the custom motion key through extendTheme as ms strings, with valid CSS vars', () => {
    const theme = extendTheme(getThemeConfig() as Parameters<typeof extendTheme>[0]);
    expect(theme.motion.duration).toEqual(
      Object.fromEntries(Object.entries(designTokens.motion.duration).map(([name, ms]) => [name, `${ms}ms`]))
    );
    const { css } = theme.generateCssVars();
    const motionVars = Object.entries(css).filter(([name]) => name.startsWith('--joy-motion'));
    expect(motionVars.length).toBe(Object.keys(designTokens.motion.duration).length);
    for (const [, value] of motionVars) expect(value).toMatch(/^\d+ms$/);
  });
});
