import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { CitableSource } from '@bike4mind/common';
import { getThemeConfig } from '../../utils/themes';
import CitableSources from './CitableSources';

// CitableSourceItem calls useNavigate, which needs a router context we don't set up here.
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const baseCitable: CitableSource = {
  id: 'https://example.com/doc',
  type: 'web_url',
  title: 'A Long Essay',
  url: 'https://example.com/doc',
  status: 'complete',
  metadata: { sourceSystem: 'web_fetch', contentLength: 50000 },
};

const renderWith = (metadata: CitableSource['metadata']) =>
  render(
    <TestWrapper>
      <CitableSources citables={[{ ...baseCitable, metadata }]} />
    </TestWrapper>
  );

describe('CitableSources truncation badge', () => {
  it('shows the truncation badge when metadata.truncated is true', () => {
    renderWith({ sourceSystem: 'web_fetch', contentLength: 50000, truncated: true, cap: 50000 });
    expect(screen.getByTestId('citable-truncated-badge')).toBeInTheDocument();
  });

  it('does not show the badge when the source was not truncated', () => {
    renderWith({ sourceSystem: 'web_fetch', contentLength: 10000, truncated: false });
    expect(screen.queryByTestId('citable-truncated-badge')).not.toBeInTheDocument();
  });

  it('does not show the badge when truncation metadata is absent', () => {
    renderWith({ sourceSystem: 'web_fetch', contentLength: 10000 });
    expect(screen.queryByTestId('citable-truncated-badge')).not.toBeInTheDocument();
  });
});
