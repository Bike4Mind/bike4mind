import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IDataLakeFindingDocument } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  findings: vi.fn(),
}));

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useDataLakeFindings: (lakeId: string | null, filters?: unknown, opts?: unknown) => h.findings(lakeId, filters, opts),
}));

// The panes fetch their own document; stubbed so this file tests the review surface rather than the
// file-read stack (FindingSourcePane.test.tsx covers that side).
vi.mock('./FindingSourcePane', () => ({
  default: ({ source }: { source: { fabFileId: string } }) => (
    <div data-testid={`finding-source-pane-${source.fabFileId}`} />
  ),
}));

import LakeFindingsChip, { LakeFindingsDialog } from './LakeFindingsDialog';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const finding = (over: Partial<IDataLakeFindingDocument> = {}): IDataLakeFindingDocument =>
  ({
    id: 'finding-1',
    lakeId: 'lake-1',
    kind: 'metric-disagreement',
    subject: 'annual recurring revenue',
    detector: 'lexical',
    documentCount: 2,
    status: 'open',
    firstSeenAt: new Date('2026-03-01T00:00:00Z'),
    lastSeenAt: new Date('2026-03-08T00:00:00Z'),
    createdAt: new Date('2026-03-01T00:00:00Z'),
    updatedAt: new Date('2026-03-08T00:00:00Z'),
    sources: [
      { fabFileId: 'file-a', fileName: 'investor-update.md', excerpt: 'ARR reached $4.2M in Q1.' },
      { fabFileId: 'file-b', fileName: 'board-deck.md', excerpt: 'ARR reached $3.7M in Q1.' },
    ],
    ...over,
  }) as IDataLakeFindingDocument;

const listing = (rows: IDataLakeFindingDocument[], over: Record<string, unknown> = {}) => ({
  data: rows,
  isLoading: false,
  error: null,
  isForbidden: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.findings.mockReturnValue(listing([finding()]));
});

const renderDialog = () =>
  render(
    <TestWrapper>
      <LakeFindingsDialog open onClose={vi.fn()} dataLakeId="lake-1" lakeName="Acme Policies" />
    </TestWrapper>
  );

describe('LakeFindingsDialog', () => {
  it('lists a lake findings, opening on the ones nobody has ruled on', () => {
    renderDialog();

    expect(screen.getByTestId('lake-finding-row-finding-1')).toBeInTheDocument();
    expect(screen.getByTestId('lake-finding-subject')).toHaveTextContent('annual recurring revenue');
    expect(h.findings).toHaveBeenCalledWith(
      'lake-1',
      { status: 'open', kind: undefined, limit: 50 },
      { enabled: true }
    );
  });

  it('narrows by status server-side', () => {
    renderDialog();

    fireEvent.click(screen.getByTestId('lake-findings-status-filter'));
    fireEvent.click(screen.getByRole('option', { name: 'Dismissed' }));

    expect(h.findings).toHaveBeenLastCalledWith(
      'lake-1',
      { status: 'dismissed', kind: undefined, limit: 50 },
      { enabled: true }
    );
  });

  it('narrows by kind server-side', () => {
    renderDialog();

    fireEvent.click(screen.getByTestId('lake-findings-kind-filter'));
    fireEvent.click(screen.getByRole('option', { name: 'Expired claim' }));

    expect(h.findings).toHaveBeenLastCalledWith(
      'lake-1',
      { status: 'open', kind: 'expired-claim', limit: 50 },
      { enabled: true }
    );
  });

  it('shows both conflicting passages side by side when a finding is opened', () => {
    renderDialog();

    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    expect(screen.getByTestId('finding-source-pane-file-a')).toBeInTheDocument();
    expect(screen.getByTestId('finding-source-pane-file-b')).toBeInTheDocument();
    // The hedge travels with the evidence: these rules are patterns over prose, never proof.
    expect(screen.getByTestId('lake-finding-advisory')).toHaveTextContent(/not proven/i);
  });

  // #3045 owns resolution and #3046 owns corpus changes; this surface reads. A button appearing
  // here is the regression that matters, because it would be a write nobody argued for.
  it('offers no way to rule on a finding or change the corpus', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    const labels = screen.getAllByRole('button').map(b => b.textContent ?? '');
    for (const forbidden of [/resolve/i, /dismiss/i, /assign/i, /merge/i, /supersede/i, /retag/i, /delete/i]) {
      expect(labels.some(label => forbidden.test(label))).toBe(false);
    }
  });

  it('opens a finding from the keyboard, not only from a mouse', () => {
    renderDialog();

    fireEvent.keyDown(screen.getByTestId('lake-finding-row-finding-1'), { key: 'Enter' });

    expect(screen.getByTestId('lake-finding-sources')).toBeInTheDocument();
  });

  it('returns to the list from a finding', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    fireEvent.click(screen.getByTestId('lake-finding-back-btn'));

    expect(screen.getByTestId('lake-findings-list')).toBeInTheDocument();
  });

  // A refetch that drops the open finding must not leave its passages on screen as if they were
  // still current - the detail is derived from the live list, not from a snapshot taken on click.
  it('falls back to the list when the open finding leaves the results', () => {
    const { rerender } = renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    h.findings.mockReturnValue(listing([]));
    rerender(
      <TestWrapper>
        <LakeFindingsDialog open onClose={vi.fn()} dataLakeId="lake-1" lakeName="Acme Policies" />
      </TestWrapper>
    );

    expect(screen.getByTestId('lake-findings-empty')).toBeInTheDocument();
  });

  // Being returned to the list by a refetch leaves no selection behind: a later filter change that
  // happens to bring the finding back must not throw the curator into its detail pane unasked.
  it('drops the selection when the filters are narrowed', () => {
    const { rerender } = renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    h.findings.mockReturnValue(listing([]));
    rerender(
      <TestWrapper>
        <LakeFindingsDialog open onClose={vi.fn()} dataLakeId="lake-1" lakeName="Acme Policies" />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('lake-findings-status-filter'));
    fireEvent.click(screen.getByRole('option', { name: 'Any status' }));

    h.findings.mockReturnValue(listing([finding()]));
    rerender(
      <TestWrapper>
        <LakeFindingsDialog open onClose={vi.fn()} dataLakeId="lake-1" lakeName="Acme Policies" />
      </TestWrapper>
    );

    expect(screen.getByTestId('lake-findings-list')).toBeInTheDocument();
    expect(screen.queryByTestId('lake-finding-sources')).not.toBeInTheDocument();
  });

  it('marks a ruled-on finding the detector has seen since', () => {
    h.findings.mockReturnValue(
      listing([
        finding({
          status: 'resolved',
          resolvedAt: new Date('2026-03-02T00:00:00Z'),
          lastSeenAt: new Date('2026-03-08T00:00:00Z'),
        }),
      ])
    );
    renderDialog();

    expect(screen.getByTestId('lake-finding-recurred')).toBeInTheDocument();
  });

  it('says an empty list means no run found anything, not that the lake is clean', () => {
    h.findings.mockReturnValue(listing([]));
    renderDialog();

    expect(screen.getByTestId('lake-findings-empty')).toHaveTextContent(/after a detection run/i);
  });

  it('explains a permission refusal rather than painting an error', () => {
    h.findings.mockReturnValue(listing(undefined as unknown as IDataLakeFindingDocument[], { isForbidden: true }));
    renderDialog();

    expect(screen.getByTestId('lake-findings-forbidden')).toBeInTheDocument();
    expect(screen.queryByTestId('lake-findings-error')).not.toBeInTheDocument();
  });

  it('says a full page is a lower bound', () => {
    h.findings.mockReturnValue(listing(Array.from({ length: 50 }, (_, i) => finding({ id: `finding-${i}` }))));
    renderDialog();

    expect(screen.getByTestId('lake-findings-truncated')).toBeInTheDocument();
  });
});

describe('LakeFindingsChip', () => {
  it('renders nothing for someone who cannot manage the lake', () => {
    render(
      <TestWrapper>
        <LakeFindingsChip lakeId="lake-1" lakeName="Acme Policies" canManage={false} />
      </TestWrapper>
    );

    expect(screen.queryByTestId('datalake-findings-chip-lake-1')).not.toBeInTheDocument();
    expect(h.findings).toHaveBeenCalledWith('lake-1', { status: 'open', limit: 50 }, { enabled: false });
  });

  it('renders nothing when there is nothing to review', () => {
    h.findings.mockReturnValue(listing([]));
    render(
      <TestWrapper>
        <LakeFindingsChip lakeId="lake-1" lakeName="Acme Policies" canManage />
      </TestWrapper>
    );

    expect(screen.queryByTestId('datalake-findings-chip-lake-1')).not.toBeInTheDocument();
  });

  // The count is of OPEN findings and the curator inside may be reading dismissed ones, so an
  // invalidation that empties that query must not take the dialog down with the chip.
  it('keeps an open dialog mounted when the open-finding count drops to zero', () => {
    const { rerender } = render(
      <TestWrapper>
        <LakeFindingsChip lakeId="lake-1" lakeName="Acme Policies" canManage />
      </TestWrapper>
    );
    fireEvent.click(within(screen.getByTestId('datalake-findings-chip-lake-1')).getByRole('button'));

    h.findings.mockReturnValue(listing([]));
    rerender(
      <TestWrapper>
        <LakeFindingsChip lakeId="lake-1" lakeName="Acme Policies" canManage />
      </TestWrapper>
    );

    expect(screen.queryByTestId('datalake-findings-chip-lake-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('lake-findings-dialog')).toBeInTheDocument();
  });

  it('counts open findings and opens the review surface', () => {
    render(
      <TestWrapper>
        <LakeFindingsChip lakeId="lake-1" lakeName="Acme Policies" canManage />
      </TestWrapper>
    );

    const chip = screen.getByTestId('datalake-findings-chip-lake-1');
    expect(chip).toHaveTextContent('1 to review');

    // Joy renders the clickable chip as a button inside the chip root, which is what a curator
    // actually presses.
    fireEvent.click(within(chip).getByRole('button'));
    expect(screen.getByTestId('lake-findings-dialog')).toBeInTheDocument();
  });
});
