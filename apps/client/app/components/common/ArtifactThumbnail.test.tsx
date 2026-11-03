import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import { ArtifactThumbnail, type ArtifactThumbnailProps } from './ArtifactThumbnail';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderThumb = (props: Partial<ArtifactThumbnailProps> = {}) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ArtifactThumbnail publicId="pub-1" title="Quarterly planning notes" data-testid="thumb" {...props} />
    </CssVarsProvider>
  );

describe('ArtifactThumbnail', () => {
  it('shows the generated cover when the artifact has no thumbnail yet', () => {
    renderThumb();
    expect(screen.getByTestId('thumb').textContent).toBe('Q');
    expect(screen.queryByTestId('thumb-image')).toBeNull();
  });

  it('renders the thumbnail as a lazy, top-anchored, decorative image when one exists', () => {
    renderThumb({ thumbnailUrl: 'https://cdn.example/thumbs/pub-1.png' });
    const img = screen.getByTestId('thumb-image') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://cdn.example/thumbs/pub-1.png');
    expect(img.getAttribute('loading')).toBe('lazy');
    // Decorative: the title beside it names the artifact.
    expect(img.getAttribute('alt')).toBe('');
    expect(img.style.objectFit).toBe('cover');
    expect(img.style.objectPosition).toBe('top');
    // No Referer to the image host: it has no need to know which app page loaded the thumbnail.
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    // The frame keeps the slot's test id, so one selector finds it in either state.
    expect(screen.getByTestId('thumb')).toContainElement(img);
  });

  it('falls back to the cover when the image fails to load', () => {
    renderThumb({ thumbnailUrl: 'https://cdn.example/thumbs/missing.png' });
    fireEvent.error(screen.getByTestId('thumb-image'));
    expect(screen.queryByTestId('thumb-image')).toBeNull();
    expect(screen.getByTestId('thumb').textContent).toBe('Q');
  });

  it('gives a new thumbnailUrl its own attempt after an earlier one failed', () => {
    const { rerender } = renderThumb({ thumbnailUrl: 'https://cdn.example/thumbs/old.png' });
    fireEvent.error(screen.getByTestId('thumb-image'));
    rerender(
      <CssVarsProvider theme={appTheme}>
        <ArtifactThumbnail
          publicId="pub-1"
          title="Quarterly planning notes"
          thumbnailUrl="https://cdn.example/thumbs/new.png"
          data-testid="thumb"
        />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('thumb-image').getAttribute('src')).toBe('https://cdn.example/thumbs/new.png');
  });

  it('treats an empty thumbnailUrl as absent rather than rendering a broken image', () => {
    renderThumb({ thumbnailUrl: '' });
    expect(screen.queryByTestId('thumb-image')).toBeNull();
  });
});
