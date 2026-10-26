import React from 'react';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import { ArtifactCover, COVER_LETTER_COLOR, coverColor } from './ArtifactCover';

/** WCAG relative luminance of an sRGB color given as 0-255 channels. */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Parse `hsl(H S% L%)` into 0-255 sRGB channels. */
function hslToRgb(color: string): [number, number, number] {
  const m = color.match(/^hsl\((\d+(?:\.\d+)?) (\d+)% (\d+)%\)$/);
  if (!m) throw new Error(`not a plain hsl() color: ${color}`);
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The interesting properties are arithmetic, so they are asserted against `coverColor` directly.
 * An earlier version of this file read `el.style.background` off the rendered node, which is always
 * `''` - Joy compiles `sx` to an emotion class - so those assertions were passing through jsdom's
 * CSS parsing rather than through the value under test. The render tests below are deliberately only
 * about the things rendering actually decides.
 */
describe('coverColor', () => {
  it('is stable for the same artifact, which is the whole point of it', () => {
    // Recognition depends on the same document being the same swatch every visit.
    expect(coverColor('pub_abc')).toBe(coverColor('pub_abc'));
  });

  it('does not depend on the title, so a rename cannot change the cover', () => {
    // Derived from publicId alone - visual recall must survive reorganising, which is exactly when
    // renames happen.
    expect(coverColor('pub_abc')).toMatch(/^hsl\(/);
    expect(coverColor.length).toBe(1); // takes only the id
  });

  it('is a single solid color, never a gradient', () => {
    expect(coverColor('pub_abc')).not.toMatch(/gradient/);
  });

  it('separates ids that differ only in their last character', () => {
    // A naive character sum would give these near-identical hues and make sibling artifacts
    // published in one batch indistinguishable.
    expect(coverColor('pub_ab1')).not.toBe(coverColor('pub_ab2'));
  });

  it('keeps collisions rare across a realistic library', () => {
    // The failure this guards was shipped once: reasoning about hash QUALITY while the output SPACE
    // is too small. Asserting the observed rate catches a shrunken space directly, where asserting
    // the constants would just restate them.
    const ids = Array.from({ length: 60 }, (_, i) => `pub_${i.toString(36)}${i * 7}`);
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(coverColor(id), (counts.get(coverColor(id)) ?? 0) + 1);
    const collidingPairs = [...counts.values()].reduce((acc, c) => acc + (c * (c - 1)) / 2, 0);
    // ~4 expected pairs at an effective 419 swatches; 10 leaves headroom for clustering while still
    // failing loudly if the space is cut back toward a dozen-odd hues.
    expect(collidingPairs).toBeLessThan(10);
  });

  it('emits a VALID color for every id in the real publicId format', () => {
    // The shipped gradient version indexed its bands with `>>`, which coerces to Int32 - and hash32
    // returns the full uint32 range, so any hash with the top bit set shifted negative, a band lookup
    // was undefined, and the whole declaration was dropped by the parser: those rows rendered the
    // empty frame this component exists to prevent, at ~44% of ids.
    //
    // GENERATED ids, not fixtures, because both fixtures in the original test were themselves broken
    // cases - which is how it got through review.
    const ids = Array.from({ length: 500 }, () => randomUUID().replace(/-/g, '').slice(0, 12));
    const broken = ids.map(coverColor).filter(c => !/^hsl\(\d+(?:\.\d+)? \d+% \d+%\)$/.test(c));
    expect(broken).toEqual([]);
  });

  it('stays within the app register rather than roaming the whole colour wheel', () => {
    // Fixed narrow saturation/lightness bands are what keep a library of covers reading as a set.
    const sats = new Set<string>();
    const lights = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const color = coverColor(`pub_${i}`);
      const m = color.match(/^hsl\(\d+(?:\.\d+)? (\d+)% (\d+)%\)$/);
      expect(m, color).not.toBeNull();
      sats.add(m![1]);
      lights.add(m![2]);
    }
    expect(sats.size).toBeLessThanOrEqual(3);
    expect(lights.size).toBeLessThanOrEqual(4);
  });

  it('keeps the letter readable on every swatch, which is what lets one letter color serve light and dark mode', () => {
    // 4.5:1 is the WCAG AA bar for small text, and the row thumbnail's letter is ~11px.
    const letter = hexToRgb(COVER_LETTER_COLOR);
    const worst = Array.from({ length: 5000 }, (_, i) => coverColor(`pub_${i}_${i * 31}`))
      .map(color => contrast(hslToRgb(color), letter))
      .reduce((min, c) => Math.min(min, c), Infinity);
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });
});

/** The letter color is a hex literal; parse it into channels for the contrast check. */
function hexToRgb(hex: string): [number, number, number] {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) throw new Error(`not a hex color: ${hex}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

const appTheme = extendTheme({ ...getThemeConfig() });
const renderCover = (publicId: string, title?: string, size?: number | 'fill') => {
  const { container } = render(
    <CssVarsProvider theme={appTheme}>
      <ArtifactCover publicId={publicId} title={title} size={size} data-testid="cover" />
    </CssVarsProvider>
  );
  return container.querySelector('[data-testid="cover"]') as HTMLElement;
};

describe('ArtifactCover', () => {
  it('shows the title initial, uppercased, as the cover letter', () => {
    expect(renderCover('pub_x', 'quarterly planning').textContent).toBe('Q');
  });

  it('takes the first visible character, ignoring leading whitespace', () => {
    expect(renderCover('pub_x', '   desktop app mockup').textContent).toBe('D');
  });

  it.each([
    [' \u{1f6b2} Ride notes', '\u{1f6b2}'],
    ['e\u0301tude', 'E\u0301'],
    ['\u{1f469}\u200d\u{1f4bb} Planning', '\u{1f469}\u200d\u{1f4bb}'],
    ['\u{1f1f5}\u{1f1ed} Routes', '\u{1f1f5}\u{1f1ed}'],
    ['   ', ''],
  ])('keeps the first visible grapheme intact for %j', (title, initial) => {
    expect(renderCover('pub_x', title).textContent).toBe(initial);
  });

  it('renders without a title', () => {
    expect(renderCover('pub_x').textContent).toBe('');
  });

  it('is decorative, so it is hidden from assistive tech', () => {
    // It carries no information a screen reader could use - the title next to it does.
    expect(renderCover('pub_x', 'T').getAttribute('aria-hidden')).toBe('true');
  });

  it('paints a solid color and no gradient', () => {
    const style = getComputedStyle(renderCover('pub_x', 'T', 26));
    expect(style.backgroundImage).not.toMatch(/gradient/);
    expect(style.background).not.toMatch(/gradient/);
    expect(style.backgroundColor).not.toBe('');
  });

  it('is the same solid color whatever the size, so a row thumb and a card cover match', () => {
    const small = getComputedStyle(renderCover('pub_same', 'T', 26)).backgroundColor;
    const fill = getComputedStyle(renderCover('pub_same', 'T', 'fill')).backgroundColor;
    expect(small).toBe(fill);
  });

  it('fills its parent in the fill variant and keeps a fixed square otherwise', () => {
    expect(getComputedStyle(renderCover('pub_x', 'T', 'fill')).width).toBe('100%');
    expect(getComputedStyle(renderCover('pub_x', 'T', 26)).width).toBe('26px');
  });
});
