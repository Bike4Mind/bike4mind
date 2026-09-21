import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { CitableSource } from '@bike4mind/common';
import { getThemeConfig } from '../../utils/themes';
import CitableSources from './CitableSources';
import { CitationInteractionProvider } from './CitationInteractionContext';
import useSessionLayout from '@client/app/hooks/useSessionLayout';

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

/**
 * The click is the seam that carries the anchor: nothing downstream can mark a passage the chip
 * never handed over, so the assertions are on the store write rather than on the viewer (#3038).
 */
describe('CitableSources cited-passage anchor', () => {
  const lakeChip = (metadata: CitableSource['metadata']): CitableSource => ({
    id: 'file-1',
    type: 'document',
    title: 'Leave policy.md',
    url: '/opti?mode=datalake&article=file-1',
    status: 'complete',
    metadata,
  });

  const clickChip = (metadata: CitableSource['metadata']) => {
    render(
      <TestWrapper>
        <CitableSources citables={[lakeChip(metadata)]} />
      </TestWrapper>
    );
    // The chip itself, not its title text: clicking the label only works while the handler happens
    // to sit on an ancestor, so it would keep passing if the click target moved off the chip.
    fireEvent.click(screen.getByTestId('citable-source-chip'));
  };

  beforeEach(() => {
    useSessionLayout.setState({ citedPassage: null });
  });

  it('hands the viewer the passage when the chip carries one', () => {
    clickChip({ sourceSystem: 'knowledge_base', chunkId: 'c1', fullContext: 'Holidays accrue monthly.' });
    expect(useSessionLayout.getState().citedPassage).toEqual({
      fileId: 'file-1',
      chunkId: 'c1',
      passage: 'Holidays accrue monthly.',
    });
  });

  it('CLEARS a previous anchor when the next chip is file-level', () => {
    // The store slot is shared. Without the clear, a keyword-arm chip would inherit the passage of
    // whatever was cited before it and mark an extent that citation never claimed.
    useSessionLayout.setState({ citedPassage: { fileId: 'other', chunkId: 'c0', passage: 'stale text' } });
    clickChip({ sourceSystem: 'knowledge_base', relevanceScore: 0.9 });
    expect(useSessionLayout.getState().citedPassage).toBeNull();
  });

  it('defers to a host override and does NOT write the anchor', () => {
    // A surface that supplies onCitationClick renders its own document view, so the shared store
    // slot is not its channel - writing it here would leave an anchor no viewer on that surface
    // clears. Pinned because the override branch returns before the anchor write.
    const onCitationClick = vi.fn();
    render(
      <TestWrapper>
        <CitationInteractionProvider value={{ onCitationClick }}>
          <CitableSources
            citables={[
              lakeChip({ sourceSystem: 'knowledge_base', chunkId: 'c1', fullContext: 'Holidays accrue monthly.' }),
            ]}
          />
        </CitationInteractionProvider>
      </TestWrapper>
    );

    fireEvent.click(screen.getByTestId('citable-source-chip'));

    expect(onCitationClick).toHaveBeenCalledTimes(1);
    expect(onCitationClick.mock.calls[0][0]).toMatchObject({ id: 'file-1' });
    expect(useSessionLayout.getState().citedPassage).toBeNull();
  });
});
