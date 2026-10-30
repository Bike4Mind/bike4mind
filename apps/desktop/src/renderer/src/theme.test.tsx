// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import Dropdown from '@mui/joy/Dropdown';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Tooltip from '@mui/joy/Tooltip';
import { avoidPageModifier } from './chat/agentBrowser';
import { DARK_PALETTE, desktopTheme, TOOLTIP_MAX_WIDTH } from './theme';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the desktop theme', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // CssVarsProvider reads the system color scheme, which jsdom does not implement.
    window.matchMedia ??= (query: string) =>
      ({ matches: false, media: query, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.removeItem('tooltip-test-mode');
  });

  it.each(['light', 'dark'] as const)('gives neutral soft tooltips and arrows an opaque %s popup fill', async mode => {
    await act(async () =>
      root.render(
        <CssVarsProvider theme={desktopTheme} defaultMode={mode} modeStorageKey="tooltip-test-mode">
          <Tooltip
            title="A floating explanation"
            variant="soft"
            open
            arrow
            slotProps={{
              root: { open: true, 'data-testid': 'theme-tooltip-root' },
              arrow: { 'data-testid': 'theme-tooltip-arrow' },
            }}
          >
            <span>anchor</span>
          </Tooltip>
        </CssVarsProvider>
      )
    );

    expect(document.documentElement.getAttribute('data-joy-color-scheme')).toBe(mode);
    const popup = desktopTheme.colorSchemes[mode].palette.background.popup;
    expect(popup).not.toMatch(/rgba|transparent/);
    const palette = desktopTheme.colorSchemes[mode].palette;
    expect(contrast(hexToRgb(palette.neutral.softColor), hexToRgb(popup))).toBeGreaterThanOrEqual(4.5);
    const tooltip = document.querySelector('[data-testid="theme-tooltip-root"]') as HTMLElement;
    expect(getComputedStyle(tooltip).backgroundColor).toBe('var(--joy-palette-background-popup)');
    const arrow = document.querySelector('[data-testid="theme-tooltip-arrow"]') as HTMLElement;
    const arrowStyles = Array.from(document.styleSheets).flatMap(sheet =>
      Array.from(sheet.cssRules).filter(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule &&
          rule.selectorText.endsWith('::before') &&
          arrow.matches(rule.selectorText.slice(0, -'::before'.length))
      )
    );
    expect(arrowStyles.length).toBeGreaterThan(0);
    for (const property of ['border-top-color', 'border-right-color']) {
      expect(
        arrowStyles
          .map(rule => rule.style.getPropertyValue(property))
          .filter(Boolean)
          .at(-1)
      ).toBe('var(--joy-palette-background-popup)');
    }
  });

  it.each([
    ['primary', 'soft'],
    ['danger', 'soft'],
    ['success', 'soft'],
    ['warning', 'soft'],
    ['neutral', 'solid'],
  ] as const)('preserves the %s %s tooltip fill', async (color, variant) => {
    await act(async () =>
      root.render(
        <CssVarsProvider theme={desktopTheme}>
          <Tooltip
            title="Semantic tooltip"
            color={color}
            variant={variant}
            open
            slotProps={{ root: { open: true, 'data-testid': 'theme-tooltip-root' } }}
          >
            <span>anchor</span>
          </Tooltip>
        </CssVarsProvider>
      )
    );

    const tooltip = document.querySelector('[data-testid="theme-tooltip-root"]') as HTMLElement;
    expect(getComputedStyle(tooltip).backgroundColor).toBe(desktopTheme.variants[variant][color].backgroundColor);
  });

  it('caps every tooltip at a width that wraps, however long its text', async () => {
    await act(async () =>
      root.render(
        <CssVarsProvider theme={desktopTheme}>
          <Tooltip title={`/srv/${'a-very-long-folder-name/'.repeat(12)}end`} open>
            <span>anchor</span>
          </Tooltip>
        </CssVarsProvider>
      )
    );

    const style = getComputedStyle(document.body.querySelector('[role="tooltip"]') as HTMLElement);
    expect(style.maxWidth).toContain(`${TOOLTIP_MAX_WIDTH}px`);
    expect(style.overflowWrap).toBe('anywhere');
  });

  it('runs every tooltip and menu through the modifier that keeps them off the browser page', async () => {
    const avoid = vi.spyOn(avoidPageModifier, 'fn');
    await act(async () =>
      root.render(
        <CssVarsProvider theme={desktopTheme}>
          <Tooltip title="Context 27k / 400k" open>
            <span>ring</span>
          </Tooltip>
          <Dropdown open>
            <MenuButton>model</MenuButton>
            <Menu>
              <MenuItem>GPT-5</MenuItem>
            </Menu>
          </Dropdown>
        </CssVarsProvider>
      )
    );

    const placed = avoid.mock.calls.map(([{ state }]) =>
      (state as unknown as { elements: { popper: Element } }).elements.popper.getAttribute('role')
    );
    expect(new Set(placed)).toEqual(new Set(['tooltip', 'menu']));
    avoid.mockRestore();
  });
});

type Rgb = [number, number, number];

const hexToRgb = (hex: string): Rgb => {
  const resolved = hex.match(/#[\da-f]+/gi)?.at(-1);
  if (!resolved) throw new Error(`Expected a hex color or CSS variable with a hex fallback: ${hex}`);
  const digits = resolved.slice(1);
  const value = Number.parseInt(digits.length === 3 ? [...digits].map(digit => digit.repeat(2)).join('') : digits, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** A Joy text token: a hex, or the `rgba(r g b / a)` the theme writes its ink steps as. */
const composite = (token: string, ground: Rgb): Rgb => {
  if (token.startsWith('#')) return hexToRgb(token);
  const [r, g, b, a] = (token.match(/[\d.]+/g) ?? []).map(Number);
  return [r, g, b].map((channel, index) => channel * a + ground[index] * (1 - a)) as Rgb;
};

const luminance = (rgb: Rgb): number => {
  const [r, g, b] = rgb.map(channel => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('the desktop dark palette', () => {
  const { palette } = desktopTheme.colorSchemes.dark;

  it('leaves the light scheme on Joy defaults', () => {
    expect(desktopTheme.colorSchemes.light.palette).toEqual(extendTheme().colorSchemes.light.palette);
  });

  it.each(['primary', 'secondary', 'tertiary'] as const)('sets text.%s at 4.5:1 or better on every ground', step => {
    for (const ground of [DARK_PALETTE.page, DARK_PALETTE.panel, DARK_PALETTE.raised]) {
      const base = hexToRgb(ground);
      expect(contrast(composite(palette.text[step], base), base)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the prompt bubble text readable at rest, on hover and when pressed', () => {
    for (const fill of [palette.primary.softBg, palette.primary.softHoverBg, palette.primary.softActiveBg]) {
      const ground = hexToRgb(fill);
      expect(contrast(composite(palette.primary.softColor, ground), ground)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the checked option index readable on the selected fill', () => {
    const ground = hexToRgb(DARK_PALETTE.selected);
    expect(contrast(composite(palette.text.secondary, ground), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the selected state and the hover tint visible against their grounds', () => {
    // Floors rather than ratios: below these the state flattens into the fill it sits on.
    expect(contrast(hexToRgb(DARK_PALETTE.selected), hexToRgb(DARK_PALETTE.stroke))).toBeGreaterThan(1.4);
    for (const ground of [DARK_PALETTE.panel, DARK_PALETTE.raised]) {
      const base = hexToRgb(ground);
      expect(contrast(composite(palette.neutral.plainHoverBg, base), base)).toBeGreaterThan(1.1);
    }
  });
});
