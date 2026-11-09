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

  it('keeps the reference metric tokens equal to what the web theme resolves to', () => {
    // These token categories are not emitted into the Joy config (the theme
    // never overrode them), so they must keep matching what Joy resolves, or
    // the tokens no longer describe what the web app renders.
    const theme = extendTheme(getThemeConfig() as Parameters<typeof extendTheme>[0]);
    expect(theme.fontSize).toEqual(designTokens.typography.fontSize);
    expect(theme.fontWeight).toEqual(designTokens.typography.fontWeight);
    expect(theme.lineHeight).toEqual(designTokens.typography.lineHeight);
    expect(theme.fontFamily.body).toBe(designTokens.typography.fontFamily.body);
    expect(theme.fontFamily.display).toBe(designTokens.typography.fontFamily.display);
    expect(theme.spacing(1)).toBe(`${designTokens.spacing.unit}px`);
    expect(theme.radius).toEqual(
      Object.fromEntries(Object.entries(designTokens.radii).map(([name, px]) => [name, `${px}px`]))
    );
    const joyShadowLayer = (layer: { offsetX: number; offsetY: number; blur: number; spread: number }): string =>
      `${layer.offsetX}px ${layer.offsetY}px ${layer.blur}px ${layer.spread}px ` +
      `rgba(var(--joy-shadowChannel, ${designTokens.shadows.channel}) / ` +
      `var(--joy-shadowOpacity, ${designTokens.shadows.opacity}))`;
    for (const [level, layers] of Object.entries(designTokens.shadows.levels)) {
      expect(theme.shadow[level as keyof typeof theme.shadow]).toBe(
        ['var(--joy-shadowRing, 0 0 #000)', ...layers.map(joyShadowLayer)].join(', ')
      );
    }
  });
});
