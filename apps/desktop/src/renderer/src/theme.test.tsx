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
  const value = Number.parseInt(hex.slice(1), 16);
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
