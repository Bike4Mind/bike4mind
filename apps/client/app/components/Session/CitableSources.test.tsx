import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { CitableSource } from '@bike4mind/common';
import { getThemeConfig } from '../../utils/themes';
import CitableSources, { conflictPlacementOf } from './CitableSources';
import { CitationInteractionProvider } from './CitationInteractionContext';
import useSessionLayout from '@client/app/hooks/useSessionLayout';

// CitableSourceItem calls useNavigate, which needs a router context we don't set up here.
const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

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
    navigate.mockClear();
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

  it('hands an internal chip to onInternalCitationClick instead of navigating or writing the anchor', () => {
    const onInternalCitationClick = vi.fn(() => true);
    render(
      <TestWrapper>
        <CitationInteractionProvider value={{ onInternalCitationClick }}>
          <CitableSources
            citables={[lakeChip({ sourceSystem: 'knowledge_base', chunkId: 'c1', fullContext: 'Text.' })]}
          />
        </CitationInteractionProvider>
      </TestWrapper>
    );

    fireEvent.click(screen.getByTestId('citable-source-chip'));

    expect(onInternalCitationClick).toHaveBeenCalledTimes(1);
    expect(onInternalCitationClick.mock.calls[0][0]).toMatchObject({ id: 'file-1' });
    expect(useSessionLayout.getState().citedPassage).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('falls back to the default navigation when onInternalCitationClick declines the chip', () => {
    const onInternalCitationClick = vi.fn(() => false);
    render(
      <TestWrapper>
        <CitationInteractionProvider value={{ onInternalCitationClick }}>
          <CitableSources
            citables={[lakeChip({ sourceSystem: 'knowledge_base', chunkId: 'c1', fullContext: 'Text.' })]}
          />
        </CitationInteractionProvider>
      </TestWrapper>
    );

    fireEvent.click(screen.getByTestId('citable-source-chip'));

    expect(onInternalCitationClick).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(useSessionLayout.getState().citedPassage).toEqual({
      fileId: 'file-1',
      chunkId: 'c1',
      passage: 'Text.',
    });
  });

  it('lets onCitationClick win over onInternalCitationClick for an internal chip', () => {
    const onCitationClick = vi.fn();
    const onInternalCitationClick = vi.fn(() => true);
    render(
      <TestWrapper>
        <CitationInteractionProvider value={{ onCitationClick, onInternalCitationClick }}>
          <CitableSources citables={[lakeChip({ sourceSystem: 'knowledge_base' })]} />
        </CitationInteractionProvider>
      </TestWrapper>
    );

    fireEvent.click(screen.getByTestId('citable-source-chip'));

    expect(onCitationClick).toHaveBeenCalledTimes(1);
    expect(onInternalCitationClick).not.toHaveBeenCalled();
  });

  it('leaves an external chip as a plain link when only onInternalCitationClick is provided', () => {
    const onInternalCitationClick = vi.fn(() => true);
    render(
      <TestWrapper>
        <CitationInteractionProvider value={{ onInternalCitationClick }}>
          <CitableSources citables={[baseCitable]} />
        </CitationInteractionProvider>
      </TestWrapper>
    );

    const chip = screen.getByTestId('citable-source-chip');
    fireEvent.click(chip);

    expect(chip.tagName).toBe('A');
    expect(chip).toHaveAttribute('href', 'https://example.com/doc');
    expect(onInternalCitationClick).not.toHaveBeenCalled();
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
    expect(screen.getByRole('img', { name: /May disagree with Annual Report\.pdf/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /May disagree with Q3 Revenue\.pdf/ })).toBeInTheDocument();
  });

  it('hedges the claim rather than asserting a contradiction', () => {
    // The detector's own contract: a finding is "worth a human's eye", never proven. Wording that
    // overclaims here would be the one place that contract is broken, since this is the only
    // surface a non-technical reader sees it on.
    // One badged chip, so the hedge resolves to a single element: the wording is identical on every
    // badge, and a two-chip fixture would match both.
    renderChips([lakeChip('file-a', 'Q3 Revenue.pdf', ['file-b']), lakeChip('file-b', 'Annual Report.pdf')]);

    expect(screen.getByRole('img', { name: /not a proven contradiction/ })).toBeInTheDocument();
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
    expect(screen.getByRole('img', { name: /May disagree with 1 further source\./ })).toBeInTheDocument();
  });

  it('renders no badge for a malformed conflictsWith rather than throwing in the reply', () => {
    // metadata is an open bag read back from a stored document, so the render path cannot assume
    // the field's shape - and a throw here would take out the whole assistant message.
    renderChips([lakeChip('file-a', 'Q3 Revenue.pdf', 'file-b')]);

    expect(screen.queryByTestId('citable-conflict-badge')).not.toBeInTheDocument();
    expect(screen.getByText('Q3 Revenue.pdf')).toBeInTheDocument();
  });

  it('names the badge without an SVG <title>, which would raise a second, native tooltip', () => {
    // The native tooltip appears below the cursor, so on the upper chip of a pair it covers the
    // partner underneath whichever side the Joy tooltip opens on.
    renderChips([lakeChip('file-a', 'Q3 Revenue.pdf', ['file-b']), lakeChip('file-b', 'Annual Report.pdf')]);

    const badge = screen.getByRole('img', { name: /May disagree with Annual Report\.pdf/ });
    expect(badge).toBe(screen.getByTestId('citable-conflict-badge'));
    expect(badge.querySelector('title')).toBeNull();
  });
});

/**
 * Chips render full-width and stack, so a tooltip on Joy's default `bottom` opens over the chip
 * below. The detector stamps conflicts symmetrically (retrievalConflictNote.ts), so both chips of a
 * pair are badged and each tooltip names the other: a single fixed side covers one partner. The
 * conflict tooltip therefore picks its side per chip, away from the partner it names.
 */
describe('CitableSources badge tooltip placement', () => {
  const lakeChip = (id: string, title: string, conflictsWith?: string[]): CitableSource => ({
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

  // Joy opens on mouseover behind a 100ms enterDelay, so the popper has to be awaited.
  const openTooltip = (badge: HTMLElement) => {
    fireEvent.mouseOver(badge);
    return screen.findByRole('tooltip');
  };

  const closeTooltip = async (badge: HTMLElement) => {
    fireEvent.mouseLeave(badge);
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  };

  // jsdom does no layout, so the box overlapping a neighbour cannot be measured directly.
  // data-popper-placement is a popper.js internal, and the only observable proxy for placement
  // here - a deliberate tradeoff, not an oversight, if an @mui/base upgrade ever moves it.
  const placementOf = async (badge: HTMLElement) => {
    const placement = (await openTooltip(badge)).getAttribute('data-popper-placement');
    await closeTooltip(badge);
    return placement;
  };

  const badgeOf = (title: string) => {
    const badge = screen
      .getAllByTestId('citable-conflict-badge')
      .find(b => b.closest('[data-testid="citable-source-chip"]')?.textContent?.includes(title));
    if (!badge) throw new Error(`no conflict badge for ${title}`);
    return badge;
  };

  it('opens each half of an adjacent pair away from the other', async () => {
    renderChips([
      lakeChip('file-a', 'Q3 Revenue.pdf', ['file-b']),
      lakeChip('file-b', 'Annual Report.pdf', ['file-a']),
    ]);

    expect(await placementOf(badgeOf('Q3 Revenue.pdf'))).toBe('top');
    expect(await placementOf(badgeOf('Annual Report.pdf'))).toBe('bottom');
  });

  it('keeps top for partners with an unrelated chip between them', async () => {
    renderChips([
      lakeChip('file-a', 'Q3 Revenue.pdf', ['file-c']),
      lakeChip('file-b', 'Support Hours.md'),
      lakeChip('file-c', 'Annual Report.pdf', ['file-a']),
    ]);

    expect(await placementOf(badgeOf('Q3 Revenue.pdf'))).toBe('top');
    expect(await placementOf(badgeOf('Annual Report.pdf'))).toBe('top');
  });

  it('keeps top for a chip with partners both above and below, since no side clears both', async () => {
    renderChips([
      lakeChip('file-a', 'Q3 Revenue.pdf', ['file-b', 'file-c']),
      lakeChip('file-b', 'Annual Report.pdf', ['file-a', 'file-c']),
      lakeChip('file-c', 'Board Deck.pdf', ['file-a', 'file-b']),
    ]);

    expect(await placementOf(badgeOf('Annual Report.pdf'))).toBe('top');
    expect(await placementOf(badgeOf('Board Deck.pdf'))).toBe('bottom');
  });

  it('outlines the partner chip, and only the partner, while the tooltip is open', async () => {
    renderChips([
      lakeChip('file-a', 'Q3 Revenue.pdf', ['file-b']),
      lakeChip('file-b', 'Annual Report.pdf', ['file-a']),
      lakeChip('file-c', 'Support Hours.md'),
    ]);
    const highlighted = () =>
      screen
        .getAllByTestId('citable-source-chip')
        .filter(chip => chip.getAttribute('data-conflict-highlighted') === 'true')
        .map(chip => chip.textContent);

    expect(highlighted()).toEqual([]);

    const badge = badgeOf('Annual Report.pdf');
    await openTooltip(badge);
    expect(highlighted()).toHaveLength(1);
    expect(highlighted()[0]).toContain('Q3 Revenue.pdf');

    await closeTooltip(badge);
    expect(highlighted()).toEqual([]);
  });

  it('opens the last visible chip bottom when its other partner is collapsed behind Show More', async () => {
    renderChips([
      lakeChip('file-x', 'Support Hours.md'),
      lakeChip('file-a', 'Q3 Revenue.pdf', ['file-b', 'file-c']),
      lakeChip('file-b', 'Annual Report.pdf', ['file-a', 'file-c']),
      lakeChip('file-c', 'Board Deck.pdf', ['file-a', 'file-b']),
    ]);

    // Board Deck is below Annual Report but not rendered, so only the partner above is in the way.
    expect(screen.queryByText('Board Deck.pdf')).not.toBeInTheDocument();
    expect(await placementOf(badgeOf('Annual Report.pdf'))).toBe('bottom');
  });

  it('clears the outline when the open badge is collapsed away without closing', async () => {
    renderChips([
      lakeChip('file-a', 'Q3 Revenue.pdf', ['file-d']),
      lakeChip('file-b', 'Support Hours.md'),
      lakeChip('file-c', 'Billing FAQ.md'),
      lakeChip('file-d', 'Annual Report.pdf', ['file-a']),
    ]);
    const isHighlighted = (title: string) =>
      screen
        .getAllByTestId('citable-source-chip')
        .find(chip => chip.textContent?.includes(title))
        ?.getAttribute('data-conflict-highlighted') === 'true';

    fireEvent.click(screen.getByTestId('citable-sources-show-more-btn'));
    await openTooltip(badgeOf('Annual Report.pdf'));
    expect(isHighlighted('Q3 Revenue.pdf')).toBe(true);

    // A click fires no mouseleave, as with a tap on touch, so the tooltip never reports a close.
    fireEvent.click(screen.getByTestId('citable-sources-show-more-btn'));
    expect(screen.queryByText('Annual Report.pdf')).not.toBeInTheDocument();
    expect(isHighlighted('Q3 Revenue.pdf')).toBe(false);
  });

  it('keeps the newer badge outline when the previous badge reports its close late', async () => {
    renderChips([
      lakeChip('file-a', 'Q3 Revenue.pdf', ['file-c']),
      lakeChip('file-b', 'Annual Report.pdf', ['file-d']),
      lakeChip('file-c', 'Board Deck.pdf', ['file-a']),
      lakeChip('file-d', 'Support Hours.md', ['file-b']),
    ]);
    fireEvent.click(screen.getByTestId('citable-sources-show-more-btn'));
    const isHighlighted = (title: string) =>
      screen
        .getAllByTestId('citable-source-chip')
        .find(chip => chip.textContent?.includes(title))
        ?.getAttribute('data-conflict-highlighted') === 'true';

    const first = badgeOf('Q3 Revenue.pdf');
    await openTooltip(first);
    fireEvent.mouseOver(badgeOf('Annual Report.pdf'));
    await waitFor(() => expect(isHighlighted('Support Hours.md')).toBe(true));

    // Joy closes the badge just left on its own timer, which can land after the next badge opened.
    fireEvent.mouseLeave(first);
    await waitFor(() => expect(screen.getAllByRole('tooltip')).toHaveLength(1));
    expect(isHighlighted('Board Deck.pdf')).toBe(false);
    expect(isHighlighted('Support Hours.md')).toBe(true);
  });

  it('opens the truncation tooltip above', async () => {
    renderWith({ sourceSystem: 'web_fetch', contentLength: 50000, truncated: true, cap: 50000 });

    expect(await openTooltip(screen.getByTestId('citable-truncated-badge'))).toHaveAttribute(
      'data-popper-placement',
      'top'
    );
  });
});

describe('conflictPlacementOf', () => {
  const chip = (id: string, conflictsWith?: unknown): CitableSource => ({
    id,
    type: 'document',
    title: `${id}.md`,
    status: 'complete',
    metadata: { sourceSystem: 'knowledge_base', ...(conflictsWith === undefined ? {} : { conflictsWith }) },
  });

  it('opens bottom only when the chip above is a partner and the one below is not', () => {
    expect(conflictPlacementOf(chip('b', ['a']), chip('a'), chip('c'))).toBe('bottom');
    expect(conflictPlacementOf(chip('b', ['a']), chip('a'), undefined)).toBe('bottom');
    expect(conflictPlacementOf(chip('b', ['c']), chip('a'), chip('c'))).toBe('top');
    expect(conflictPlacementOf(chip('b', ['a', 'c']), chip('a'), chip('c'))).toBe('top');
  });

  it('keeps top for the first chip and for a partner that is not rendered', () => {
    expect(conflictPlacementOf(chip('a', ['b']), undefined, chip('b'))).toBe('top');
    // Collapsed behind Show More: the partner is simply not the neighbour passed in.
    expect(conflictPlacementOf(chip('c', ['d']), chip('b'), undefined)).toBe('top');
  });

  it.each([
    ['a string', 'a'],
    ['absent', undefined],
    ['non-string ids', [1, null]],
  ])('keeps top for a malformed conflictsWith (%s)', (_name, conflictsWith) => {
    expect(conflictPlacementOf(chip('b', conflictsWith), chip('a'), undefined)).toBe('top');
  });

  it('ignores a neighbour without an id', () => {
    expect(conflictPlacementOf(chip('b', ['']), { ...chip('x'), id: '' }, undefined)).toBe('top');
  });
});

/**
 * Internal chips name where the file came from. `owned` is the conversation owner's, so the labels
 * are asserted to be neutral rather than viewer-relative.
 */
describe('CitableSources origin label', () => {
  const internalChip = (id: string, sourceOrigin?: unknown): CitableSource => ({
    id,
    type: 'document',
    title: `${id}.md`,
    url: `/opti?mode=datalake&article=${id}`,
    status: 'complete',
    metadata: { sourceSystem: 'knowledge_base', ...(sourceOrigin === undefined ? {} : { sourceOrigin }) },
  });

  const labelsOf = (citables: CitableSource[]) => {
    render(
      <TestWrapper>
        <CitableSources citables={citables} />
      </TestWrapper>
    );
    return screen.getAllByTestId('citable-source-origin-label').map(el => el.textContent);
  };

  it('names each chip by its own lake or library', () => {
    expect(
      labelsOf([
        internalChip('a', { kind: 'lake', lakes: [{ id: 'a', name: 'Alpha Lake' }] }),
        internalChip('b', { kind: 'lake', lakes: [{ id: 'b', name: 'Beta Lake' }] }),
        internalChip('c', { kind: 'library', owned: true }),
      ])
    ).toEqual(['Alpha Lake', 'Beta Lake', 'Personal library']);
  });

  it('summarises a multi-lake chip and lists every lake in the tooltip', async () => {
    const [label] = labelsOf([
      internalChip('a', {
        kind: 'lake',
        lakes: [
          { id: 'a', name: 'Alpha Lake' },
          { id: 'b', name: 'Beta Lake' },
          { id: 'c', name: 'Gamma Lake' },
        ],
      }),
    ]);
    expect(label).toBe('Alpha Lake +2');

    fireEvent.mouseOver(screen.getByTestId('citable-source-origin-label'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Alpha Lake, Beta Lake, Gamma Lake');
  });

  it('labels a library file the owner does not own as shared', () => {
    expect(labelsOf([internalChip('a', { kind: 'library', owned: false })])).toEqual(['Shared library']);
  });

  it('keeps Data Lake for a chip with no origin', () => {
    expect(labelsOf([internalChip('a')])).toEqual(['Data Lake']);
  });

  it.each([
    ['lakes not an array', { kind: 'lake', lakes: 'x' }],
    ['empty lakes', { kind: 'lake', lakes: [] }],
    ['lakes without string names', { kind: 'lake', lakes: [{ id: 'a' }, null, { id: 'b', name: 7 }] }],
    ['unknown kind', { kind: 'weird' }],
    ['library without boolean owned', { kind: 'library', owned: 'yes' }],
    ['a string', 'string'],
    ['null', null],
  ])('falls back to Data Lake for a malformed origin (%s)', (_name, origin) => {
    expect(labelsOf([internalChip('a', origin)])).toEqual(['Data Lake']);
  });

  it('skips lake entries without a name but keeps the rest', () => {
    expect(
      labelsOf([internalChip('a', { kind: 'lake', lakes: [{ id: 'x' }, { id: 'b', name: 'Beta Lake' }] })])
    ).toEqual(['Beta Lake']);
  });

  it('leaves an external web chip on its hostname', () => {
    render(
      <TestWrapper>
        <CitableSources citables={[baseCitable]} />
      </TestWrapper>
    );
    expect(screen.queryByTestId('citable-source-origin-label')).not.toBeInTheDocument();
    expect(screen.getByText('example.com')).toBeInTheDocument();
  });
});
