import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import { ArtifactCover } from './ArtifactCover';

const appTheme = extendTheme({ ...getThemeConfig() });
const cover = (publicId: string, title?: string) => {
  const { container } = render(
    <CssVarsProvider theme={appTheme}>
      <ArtifactCover publicId={publicId} title={title} data-testid="cover" />
    </CssVarsProvider>
  );
  return container.querySelector('[data-testid="cover"]') as HTMLElement;
};
const bg = (el: HTMLElement) => el.style.background || getComputedStyle(el).background;

describe('ArtifactCover', () => {
  it('is stable for the same artifact, which is the whole point of it', () => {
    // Recognition depends on the same document being the same swatch every visit.
    expect(bg(cover('pub_abc'))).toBe(bg(cover('pub_abc')));
  });

  it('does not change when the artifact is renamed', () => {
    // Derived from publicId, not the title - a rename must not break visual recall.
    expect(bg(cover('pub_abc', 'Original Title'))).toBe(bg(cover('pub_abc', 'Renamed Entirely')));
  });

  it('separates ids that differ only in their last character', () => {
    // A naive character sum would give these near-identical hues and make sibling artifacts
    // published in one batch indistinguishable.
    expect(bg(cover('pub_ab1'))).not.toBe(bg(cover('pub_ab2')));
  });

  it('shows the title initial as a secondary cue', () => {
    expect(cover('pub_x', 'ionq weekly').textContent).toBe('I');
  });

  it('renders without a title', () => {
    expect(cover('pub_x').textContent).toBe('');
  });

  it('is decorative, so it is hidden from assistive tech', () => {
    // It carries no information a screen reader could use - the title next to it does.
    expect(cover('pub_x', 'T').getAttribute('aria-hidden')).toBe('true');
  });
});
