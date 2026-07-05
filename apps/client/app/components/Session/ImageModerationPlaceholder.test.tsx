import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../utils/themes';
import { ImageModerationPlaceholder } from './ImageModerationPlaceholder';

const appTheme = extendTheme({ ...getThemeConfig() });

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('ImageModerationPlaceholder', () => {
  it('renders a scanning state with a spinner and caption', () => {
    render(
      <TestWrapper>
        <ImageModerationPlaceholder status="scanning" />
      </TestWrapper>
    );

    expect(screen.getByTestId('image-moderation-scanning')).toBeInTheDocument();
    expect(screen.getByText('Scanning for safety…')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('renders a blocked state with the content-policy copy', () => {
    render(
      <TestWrapper>
        <ImageModerationPlaceholder status="blocked" />
      </TestWrapper>
    );

    expect(screen.getByTestId('image-moderation-blocked')).toBeInTheDocument();
    expect(screen.getByText("This image couldn't be added — it may violate our content policy.")).toBeInTheDocument();
  });

  // At small icon sizes (Files/Browser/Item.tsx passes 20/32px) the full caption
  // overflowed the `size x size` box and clipped into an illegible sliver inside the
  // ListItem's `overflow: hidden`. Below the compact threshold, only the spinner/icon
  // should render - no caption text - while larger (thumbnail) usages keep it.
  describe('compact variant (small sizes)', () => {
    it('renders scanning icon-only (no caption) at a small size', () => {
      render(
        <TestWrapper>
          <ImageModerationPlaceholder status="scanning" size={20} />
        </TestWrapper>
      );

      expect(screen.getByTestId('image-moderation-scanning')).toBeInTheDocument();
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByText('Scanning for safety…')).not.toBeInTheDocument();
      // Caption is still exposed on hover via the title attribute.
      expect(screen.getByTestId('image-moderation-scanning')).toHaveAttribute('title', 'Scanning for safety…');
    });

    it('renders blocked icon-only (no caption) at a small size', () => {
      render(
        <TestWrapper>
          <ImageModerationPlaceholder status="blocked" size={32} />
        </TestWrapper>
      );

      const el = screen.getByTestId('image-moderation-blocked');
      expect(el).toBeInTheDocument();
      expect(
        screen.queryByText("This image couldn't be added — it may violate our content policy.")
      ).not.toBeInTheDocument();
      expect(el).toHaveAttribute('title', "This image couldn't be added — it may violate our content policy.");
      // A warning icon (svg) is still rendered.
      expect(el.querySelector('svg')).toBeInTheDocument();
    });

    it('keeps the full caption variant at the default (large/thumbnail) size', () => {
      render(
        <TestWrapper>
          <ImageModerationPlaceholder status="scanning" />
        </TestWrapper>
      );

      expect(screen.getByText('Scanning for safety…')).toBeInTheDocument();
    });
  });
});
