import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import { ArtifactCover, coverGradient } from './ArtifactCover';

/**
 * The interesting properties are arithmetic, so they are asserted against `coverGradient` directly.
 * An earlier version of this file read `el.style.background` off the rendered node, which is always
 * `''` - Joy compiles `sx` to an emotion class - so those assertions were passing through jsdom's
 * CSS parsing rather than through the value under test. The render test below is deliberately only
 * about the things rendering actually decides.
 */
describe('coverGradient', () => {
  it('is stable for the same artifact, which is the whole point of it', () => {
    // Recognition depends on the same document being the same swatch every visit.
    expect(coverGradient('pub_abc')).toBe(coverGradient('pub_abc'));
  });

  it('does not depend on the title, so a rename cannot change the cover', () => {
    // Derived from publicId alone - visual recall must survive reorganising, which is exactly when
    // renames happen.
    expect(coverGradient('pub_abc')).toMatch(/^linear-gradient\(/);
    expect(coverGradient.length).toBe(1); // takes only the id
  });

  it('separates ids that differ only in their last character', () => {
    // A naive character sum would give these near-identical hues and make sibling artifacts
    // published in one batch indistinguishable.
    expect(coverGradient('pub_ab1')).not.toBe(coverGradient('pub_ab2'));
  });

  it('keeps collisions rare across a realistic library', () => {
    // The failure this guards was shipped once: reasoning about hash QUALITY while the output SPACE
    // is too small. FNV-1a distributes fine into 96 buckets - and 96 buckets means roughly eight
    // identical-looking pairs at forty artifacts, which defeats the recognition the cover exists
    // for. Asserting the observed rate catches a shrunken space directly, where asserting the
    // constants would just restate them.
    const ids = Array.from({ length: 60 }, (_, i) => `pub_${i.toString(36)}${i * 7}`);
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(coverGradient(id), (counts.get(coverGradient(id)) ?? 0) + 1);
    const collidingPairs = [...counts.values()].reduce((acc, c) => acc + (c * (c - 1)) / 2, 0);
    // ~1 expected pair at 1,728 combinations; 6 leaves headroom for clustering while still failing
    // loudly if the space is cut back toward the old 96.
    expect(collidingPairs).toBeLessThan(6);
  });

  it('stays within the app register rather than roaming the whole colour wheel', () => {
    // Fixed narrow saturation/lightness bands are what keep a library of covers reading as a set.
    const sats = new Set<string>();
    const lights = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const m = coverGradient(`pub_${i}`).match(/hsl\(\d+(?:\.\d+)? (\d+)% (\d+)%\)/);
      if (m) {
        sats.add(m[1]);
        lights.add(m[2]);
      }
    }
    expect(sats.size).toBeLessThanOrEqual(3);
    expect(lights.size).toBeLessThanOrEqual(3);
  });
});

const appTheme = extendTheme({ ...getThemeConfig() });
const renderCover = (publicId: string, title?: string) => {
  const { container } = render(
    <CssVarsProvider theme={appTheme}>
      <ArtifactCover publicId={publicId} title={title} data-testid="cover" />
    </CssVarsProvider>
  );
  return container.querySelector('[data-testid="cover"]') as HTMLElement;
};

describe('ArtifactCover', () => {
  it('shows the title initial as a secondary cue', () => {
    expect(renderCover('pub_x', 'ionq weekly').textContent).toBe('I');
  });

  it('renders without a title', () => {
    expect(renderCover('pub_x').textContent).toBe('');
  });

  it('is decorative, so it is hidden from assistive tech', () => {
    // It carries no information a screen reader could use - the title next to it does.
    expect(renderCover('pub_x', 'T').getAttribute('aria-hidden')).toBe('true');
  });
});
