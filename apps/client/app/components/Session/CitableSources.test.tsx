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

/**
 * The reader's half of the retrieval conflict signal (#3041). The model is told two retrieved
 * documents disagree; these assertions pin that the reader is told the same thing, and told it
 * as a heuristic rather than as a proven contradiction.
 */
describe('CitableSources conflict badge', () => {
  const lakeChip = (id: string, title: string, conflictsWith?: unknown): CitableSource => ({
    id,
    type: 'document',
    title,
    url: `/opti?mode=datalake&article=${id}`,
    status: 'complete',
    metadata: { sourceSystem: 'knowledge_base', ...(conflictsWith === undefined ? {} : { conflictsWith }) },
  });

  const renderChips = (citables: CitableSource[]) =>
    render(
      <TestWrapper>
        <CitableSources citables={citables} />
      </TestWrapper>
    );

  it('badges both halves of a pair and names the other source', () => {
    renderChips([
      lakeChip('file-a', 'Q3 Revenue.pdf', ['file-b']),
      lakeChip('file-b', 'Annual Report.pdf', ['file-a']),
    ]);

    expect(screen.getAllByTestId('citable-conflict-badge')).toHaveLength(2);
    expect(screen.getByTitle(/May disagree with Annual Report\.pdf/)).toBeInTheDocument();
    expect(screen.getByTitle(/May disagree with Q3 Revenue\.pdf/)).toBeInTheDocument();
  });

  it('hedges the claim rather than asserting a contradiction', () => {
    // The detector's own contract: a finding is "worth a human's eye", never proven. Wording that
    // overclaims here would be the one place that contract is broken, since this is the only
    // surface a non-technical reader sees it on.
    // One badged chip, so the hedge resolves to a single element: the wording is identical on every
    // badge, and a two-chip fixture would match both.
    renderChips([lakeChip('file-a', 'Q3 Revenue.pdf', ['file-b']), lakeChip('file-b', 'Annual Report.pdf')]);

    expect(screen.getByTitle(/not a proven contradiction/)).toBeInTheDocument();
  });

  it('leaves an unmarked source unbadged', () => {
    renderChips([
      lakeChip('file-a', 'Q3 Revenue.pdf', ['file-b']),
      lakeChip('file-b', 'Annual Report.pdf', ['file-a']),
      lakeChip('file-c', 'Support Hours.md'),
    ]);

    expect(screen.getAllByTestId('citable-conflict-badge')).toHaveLength(2);
  });

  it('shows no badge when no source carries a conflict', () => {
    renderChips([lakeChip('file-a', 'Q3 Revenue.pdf'), lakeChip('file-b', 'Annual Report.pdf')]);

    expect(screen.queryByTestId('citable-conflict-badge')).not.toBeInTheDocument();
  });

  it('keeps the badge when the partner is not among the rendered chips', () => {
    // A real conflict whose partner lost the dedup upstream. Dropping the badge would hide a true
    // signal; naming an id the reader cannot match to a chip would be noise. So it counts instead.
    renderChips([lakeChip('file-a', 'Q3 Revenue.pdf', ['file-missing'])]);

    expect(screen.getByTestId('citable-conflict-badge')).toBeInTheDocument();
    expect(screen.getByTitle(/May disagree with 1 further source\./)).toBeInTheDocument();
  });

  it('renders no badge for a malformed conflictsWith rather than throwing in the reply', () => {
    // metadata is an open bag read back from a stored document, so the render path cannot assume
    // the field's shape - and a throw here would take out the whole assistant message.
    renderChips([lakeChip('file-a', 'Q3 Revenue.pdf', 'file-b')]);

    expect(screen.queryByTestId('citable-conflict-badge')).not.toBeInTheDocument();
    expect(screen.getByText('Q3 Revenue.pdf')).toBeInTheDocument();
  });
});

/**
 * Chips render full-width and stack, so a tooltip left on Joy's default `bottom` opens over the
 * chip below. `placement="top"` clears that for the upper chip of a pair. It does NOT clear the
 * problem in general: the detector stamps conflicts symmetrically (retrievalConflictNote.ts builds
 * `conflictsWith` from every other member of a group), so both chips of a pair are badged and the
 * lower one's tooltip now opens over the partner above it. The occlusion moves rather than going
 * away, and no placement clears both on a stacked list of full-width chips. The mutual fixture
 * below pins the shape the detector actually emits so that stays visible (#3290).
 */
describe('CitableSources badge tooltips open above the chip', () => {
  const lakeChip = (id: string, title: string, conflictsWith?: string[]): CitableSource => ({
    id,
    type: 'document',
    title,
    url: `/opti?mode=datalake&article=${id}`,
    status: 'complete',
    metadata: { sourceSystem: 'knowledge_base', ...(conflictsWith === undefined ? {} : { conflictsWith }) },
  });

  // Joy opens on mouseover behind a 100ms enterDelay, so the popper has to be awaited.
  const openTooltip = (badge: HTMLElement) => {
    fireEvent.mouseOver(badge);
    return screen.findByRole('tooltip');
  };

  // jsdom does no layout, so the box overlapping a neighbour cannot be measured directly.
  // data-popper-placement is a popper.js internal, and the only observable proxy for placement
  // here - a deliberate tradeoff, not an oversight, if an @mui/base upgrade ever moves it.
  const expectOpensAbove = async (badge: HTMLElement) =>
    expect(await openTooltip(badge)).toHaveAttribute('data-popper-placement', 'top');

  it('opens both halves of a mutually conflicting pair above their chip', async () => {
    render(
      <TestWrapper>
        <CitableSources
          citables={[
            lakeChip('file-a', 'Q3 Revenue.pdf', ['file-b']),
            lakeChip('file-b', 'Annual Report.pdf', ['file-a']),
          ]}
        />
      </TestWrapper>
    );

    // Both, not just the upper one: asserting only the top chip would read as coverage for a
    // case this change does not fix (see the block comment).
    const badges = screen.getAllByTestId('citable-conflict-badge');
    expect(badges).toHaveLength(2);
    for (const badge of badges) {
      await expectOpensAbove(badge);
    }
  });

  it('opens the truncation tooltip above too', async () => {
    renderWith({ sourceSystem: 'web_fetch', contentLength: 50000, truncated: true, cap: 50000 });

    await expectOpensAbove(screen.getByTestId('citable-truncated-badge'));
  });
});
