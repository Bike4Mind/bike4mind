import { describe, expect, it } from 'vitest';
import { extendTheme } from '@mui/joy/styles';
import { components, getThemeConfig } from './themePrimitives';

/**
 * WCAG AA for body text is 4.5:1. Each text token is measured against every surface the app sets
 * body copy on, compositing an rgba token over the surface the way the browser does. A translucent
 * surface (a hovered notebook row) is itself composited over background.body first.
 */
const theme = extendTheme({ ...getThemeConfig() });
const MODES = ['light', 'dark'] as const;
const TEXT_TOKENS = ['primary', 'secondary', 'tertiary', 'primary50', 'primary70'] as const;
const SURFACES = [
  'background.body',
  'background.surface',
  'background.surface2',
  'background.panel',
  'background.panel2',
  'background.level1',
  'background.level2',
  'notebooklist.hoverBg',
  'notebooklist.focusedBackground',
  'chatbox.replyBg',
] as const;
const AA_TEXT = 4.5;

type Rgba = [number, number, number, number];

const parse = (color: string): Rgba => {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as Rgba;
  const fallback = color.match(/^var\([^,]+,\s*(#[0-9a-f]{6})\)$/i);
  if (fallback) return parse(fallback[1]);
  const fn = color.match(/^rgba?\(([^)]+)\)$/);
  if (fn) {
    const [r, g, b, a = '1'] = fn[1].split(',').map(part => part.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  throw new Error(`unparsed colour ${color}`);
};

const luminance = ([r, g, b]: number[]) => {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (fg: string, bg: string) => {
  const [r, g, b, a] = parse(fg);
  const back = parse(bg);
  const shown = [r, g, b].map((c, i) => c * a + back[i] * (1 - a));
  const [hi, lo] = [luminance(shown), luminance(back)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

type Palette = Record<string, Record<string, string>>;

const surfaceColor = (palette: Palette, path: string) => {
  const [group, key] = path.split('.');
  const [r, g, b, a] = parse(palette[group][key]);
  if (a === 1) return `rgb(${r}, ${g}, ${b})`;
  const [br, bg, bb] = parse(palette.background.body);
  return `rgb(${[r, g, b].map((c, i) => Math.round(c * a + [br, bg, bb][i] * (1 - a))).join(', ')})`;
};

describe('text token contrast', () => {
  it.each(MODES)('%s: every text token reaches 4.5:1 on every surface', mode => {
    const palette = theme.colorSchemes[mode].palette as unknown as Palette;
    const failures = TEXT_TOKENS.flatMap(token =>
      SURFACES.map(surface => ({
        token,
        surface,
        ratio: contrast(palette.text[token], surfaceColor(palette, surface)),
      }))
    )
      .filter(({ ratio }) => ratio < AA_TEXT)
      .map(({ token, surface, ratio }) => `text.${token} on ${surface}: ${ratio.toFixed(2)}`);
    expect(failures).toEqual([]);
  });

  it.each(MODES)('%s: input and textarea placeholders reach 4.5:1', mode => {
    const palette = theme.colorSchemes[mode].palette as unknown as Palette;
    const opacity = [
      components.JoyInput.styleOverrides.root['--Input-placeholderOpacity'],
      components.JoyTextarea.styleOverrides.root['--Textarea-placeholderOpacity'],
    ];
    const rgba = (alpha: number) => {
      const [r, g, b] = parse(palette.text.primary);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };
    const failures = opacity.flatMap(alpha =>
      (['background.body', 'background.surface', 'background.surface2'] as const).map(surface => ({
        alpha,
        surface,
        ratio: contrast(rgba(alpha), surfaceColor(palette, surface)),
      }))
    )
      .filter(({ ratio }) => ratio < AA_TEXT)
      .map(({ alpha, surface, ratio }) => `placeholder at ${alpha} on ${surface}: ${ratio.toFixed(2)}`);
    expect(failures).toEqual([]);
  });

  it('measures a known pair correctly, so a broken parser cannot pass', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('rgba(0, 0, 0, 0)', '#FFFFFF')).toBeCloseTo(1, 5);
  });
});
