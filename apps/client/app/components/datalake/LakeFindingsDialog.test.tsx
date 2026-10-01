import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IDataLakeFindingDocument, LakeHealthApiResponse } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  findings: vi.fn(),
  health: vi.fn(),
  scan: vi.fn(),
  scanLakeId: vi.fn(),
  scanPending: { value: false },
  rule: vi.fn(),
  rulePending: { value: false },
  access: vi.fn(),
}));

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useDataLakeFindings: (lakeId: string | null, filters?: unknown, opts?: unknown) => h.findings(lakeId, filters, opts),
  useGetDataLakeHealth: (lakeId: string | null, enabled?: boolean) => h.health(lakeId, enabled),
  useScanDataLakeFindings: (lakeId: string) => {
    h.scanLakeId(lakeId);
    return { mutate: h.scan, isPending: h.scanPending.value };
  },
  useRuleOnDataLakeFinding: () => ({ mutate: h.rule, isPending: h.rulePending.value }),
  useLakeAccessView: (lakeId: string | null, enabled?: boolean) => h.access(lakeId, enabled),
}));

// The assignee control reads the signed-in user to offer "Assign to me"; the real store is a
// persisted zustand hook whose provider this file does not mount.
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (state: { currentUser: { id: string } | null }) => unknown) =>
    selector({ currentUser: { id: 'me' } }),
}));

// The panes fetch their own document; stubbed so this file tests the review surface rather than the
// file-read stack (FindingSourcePane.test.tsx covers that side).
vi.mock('./FindingSourcePane', () => ({
  default: ({ source }: { source: { fabFileId: string } }) => (
    <div data-testid={`finding-source-pane-${source.fabFileId}`} />
  ),
}));

import LakeFindingsChip, { LakeFindingsDialog } from './LakeFindingsDialog';
import { formatFindingDate } from './findingCopy';

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
  hasMore: false,
  loadMore: vi.fn(),
  isLoadingMore: false,
  ...over,
});

const scanned = (over: Partial<NonNullable<LakeHealthApiResponse['inconsistency']>> = {}) => ({
  data: {
    inconsistency: {
      computedAt: '2026-03-08T12:00:00Z',
      sampled: true,
      memberSampled: false,
      memberCount: 4,
      findingCount: 0,
      truncated: false,
      countsByKind: {},
      ...over,
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.scanPending.value = false;
  h.rulePending.value = false;
  h.findings.mockReturnValue(listing([finding()]));
  h.health.mockReturnValue({ data: undefined });
  // No access view by default: the assignee picker stays hidden and the self-assign controls stand
  // on their own, which is all the ruling tests need.
  h.access.mockReturnValue({ data: undefined });
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
    // Accessible names: close button and both filter selects carry an aria-label.
    expect(screen.getByTestId('lake-findings-close-btn')).toHaveAttribute('aria-label', 'Close findings dialog');
    expect(screen.getByTestId('lake-findings-status-filter')).toHaveAttribute('aria-label', 'Filter by status');
    expect(screen.getByTestId('lake-findings-kind-filter')).toHaveAttribute('aria-label', 'Filter by finding kind');
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

  // #3046 owns corpus changes; the detail view may now rule on a finding, but a control that
  // mutated the corpus would be a write nobody argued for.
  it('offers no way to change the corpus', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    const labels = screen.getAllByRole('button').map(b => b.textContent ?? '');
    for (const forbidden of [/merge/i, /supersede/i, /retag/i, /delete/i]) {
      expect(labels.some(label => forbidden.test(label))).toBe(false);
    }
  });

  it('rules an open finding resolved with the note the curator typed', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    fireEvent.change(screen.getByTestId('lake-finding-resolution-input'), {
      target: { value: 'The board deck was out of date.' },
    });
    fireEvent.click(screen.getByTestId('lake-finding-resolve-btn'));

    expect(h.rule).toHaveBeenCalledWith({
      findingId: 'finding-1',
      action: 'resolve',
      resolution: 'The board deck was out of date.',
    });
  });

  it('dismisses an open finding, sending no note when the field is empty', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    fireEvent.click(screen.getByTestId('lake-finding-dismiss-btn'));

    expect(h.rule).toHaveBeenCalledWith({ findingId: 'finding-1', action: 'dismiss', resolution: undefined });
  });

  it('does not send a whitespace-only note', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    fireEvent.change(screen.getByTestId('lake-finding-resolution-input'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('lake-finding-resolve-btn'));

    expect(h.rule).toHaveBeenCalledWith({ findingId: 'finding-1', action: 'resolve', resolution: undefined });
  });

  it('blocks a second ruling while one is in flight', () => {
    h.rulePending.value = true;
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    expect(screen.getByTestId('lake-finding-resolve-btn')).toBeDisabled();
    expect(screen.getByTestId('lake-finding-dismiss-btn')).toBeDisabled();
    expect(screen.getByTestId('lake-finding-assign-me-btn')).toBeDisabled();
  });

  it('blocks an assignment while a ruling is in flight', () => {
    h.rulePending.value = true;
    h.findings.mockReturnValue(listing([finding({ assigneeUserId: 'u2' })]));
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    expect(screen.getByTestId('lake-finding-unassign-btn')).toBeDisabled();
  });

  it('reads a closed finding as a ruling, with no way to rule on it again', () => {
    h.findings.mockReturnValue(
      listing([
        finding({
          status: 'resolved',
          resolvedAt: new Date('2026-03-04T00:00:00Z'),
          resolution: 'Both figures were reconciled in the Q2 update.',
        }),
      ])
    );
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    expect(screen.getByTestId('lake-finding-ruling')).toHaveTextContent(/resolved/i);
    expect(screen.getByTestId('lake-finding-ruling')).toHaveTextContent(/Both figures were reconciled/);
    expect(screen.queryByTestId('lake-finding-resolve-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lake-finding-dismiss-btn')).not.toBeInTheDocument();
  });

  it('dates a dismissed finding and marks it as seen again in the detail view', () => {
    const ruledAt = new Date('2026-03-04T00:00:00Z');
    h.findings.mockReturnValue(
      listing([
        finding({
          status: 'dismissed',
          resolvedAt: ruledAt,
          lastSeenAt: new Date('2026-03-08T00:00:00Z'),
        }),
      ])
    );
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    const ruling = screen.getByTestId('lake-finding-ruling');
    expect(ruling).toHaveTextContent('Dismissed on');
    expect(ruling).toHaveTextContent(formatFindingDate(ruledAt));
    expect(within(ruling).getByTestId('lake-finding-recurred')).toBeInTheDocument();
  });

  it('assigns an unassigned finding to the current user', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    expect(screen.getByTestId('lake-finding-assignee')).toHaveTextContent('Unassigned');
    fireEvent.click(screen.getByTestId('lake-finding-assign-me-btn'));

    expect(h.rule).toHaveBeenCalledWith({ findingId: 'finding-1', action: 'assign', assigneeUserId: 'me' });
  });

  it('names a listed assignee and unassigns on request', () => {
    h.access.mockReturnValue({
      data: {
        view: {
          grants: [
            {
              principalType: 'user',
              principalId: 'u2',
              principalName: 'Test Curator',
              role: 'curator',
              status: 'active',
            },
          ],
        },
      },
    });
    h.findings.mockReturnValue(listing([finding({ assigneeUserId: 'u2' })]));
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    expect(screen.getByTestId('lake-finding-assignee')).toHaveTextContent('Test Curator');
    fireEvent.click(screen.getByTestId('lake-finding-unassign-btn'));

    expect(h.rule).toHaveBeenCalledWith({ findingId: 'finding-1', action: 'assign', assigneeUserId: null });
  });

  it('assigns a listed candidate chosen from the picker', () => {
    h.access.mockReturnValue({
      data: {
        view: {
          grants: [
            {
              principalType: 'user',
              principalId: 'u2',
              principalName: 'Test Curator',
              role: 'curator',
              status: 'active',
            },
          ],
        },
      },
    });
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    expect(screen.getByTestId('lake-finding-assignee-select')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('lake-finding-assignee-select'));
    fireEvent.click(screen.getByRole('option', { name: 'Test Curator' }));

    expect(h.rule).toHaveBeenCalledWith({ findingId: 'finding-1', action: 'assign', assigneeUserId: 'u2' });
  });

  it('clears the assignee through the picker', () => {
    h.access.mockReturnValue({
      data: {
        view: {
          grants: [
            {
              principalType: 'user',
              principalId: 'u2',
              principalName: 'Test Curator',
              role: 'curator',
              status: 'active',
            },
          ],
        },
      },
    });
    h.findings.mockReturnValue(listing([finding({ assigneeUserId: 'u2' })]));
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    fireEvent.click(screen.getByTestId('lake-finding-assignee-select'));
    fireEvent.click(screen.getByRole('option', { name: 'Unassigned' }));

    expect(h.rule).toHaveBeenCalledWith({ findingId: 'finding-1', action: 'assign', assigneeUserId: null });
  });

  it('lists only active owner and curator user grants as candidates', () => {
    h.access.mockReturnValue({
      data: {
        view: {
          grants: [
            { principalType: 'user', principalId: 'u1', principalName: 'Owner One', role: 'owner', status: 'active' },
            {
              principalType: 'user',
              principalId: 'u2',
              principalName: 'Lapsed Curator',
              role: 'curator',
              status: 'expired',
            },
            { principalType: 'user', principalId: 'u3', principalName: 'A Reader', role: 'reader', status: 'active' },
            {
              principalType: 'organization',
              principalId: 'o1',
              principalName: 'An Org',
              role: 'owner',
              status: 'active',
            },
          ],
        },
      },
    });
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));
    fireEvent.click(screen.getByTestId('lake-finding-assignee-select'));

    expect(screen.getByRole('option', { name: 'Owner One' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Lapsed Curator' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'A Reader' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'An Org' })).not.toBeInTheDocument();
  });

  it('falls back to a placeholder name for a grant the server could not resolve', () => {
    h.access.mockReturnValue({
      data: {
        view: {
          grants: [{ principalType: 'user', principalId: 'u4', role: 'curator', status: 'active' }],
        },
      },
    });
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));
    fireEvent.click(screen.getByTestId('lake-finding-assignee-select'));

    expect(screen.getByRole('option', { name: 'Unnamed curator' })).toBeInTheDocument();
  });

  it('names an assignee who holds no listed grant and keeps the picker on that value', () => {
    h.access.mockReturnValue({
      data: {
        view: {
          grants: [
            {
              principalType: 'user',
              principalId: 'u2',
              principalName: 'Test Curator',
              role: 'curator',
              status: 'active',
            },
          ],
        },
      },
    });
    h.findings.mockReturnValue(listing([finding({ assigneeUserId: 'org-admin-1' })]));
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    expect(screen.getByTestId('lake-finding-assignee')).toHaveTextContent('Assigned to someone not listed');
    // The Select's value must stay among its options, or the control renders blank.
    fireEvent.click(screen.getByTestId('lake-finding-assignee-select'));
    expect(screen.getByRole('option', { name: 'Assigned to someone not listed' })).toBeInTheDocument();
  });

  it('reads a finding already assigned to the current user without offering a self-assign', () => {
    // The default access view has no grants, so "me" is not a listed candidate - the picker hides
    // and the label alone carries the state.
    h.findings.mockReturnValue(listing([finding({ assigneeUserId: 'me' })]));
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    expect(screen.getByTestId('lake-finding-assignee')).toHaveTextContent('Assigned to you');
    expect(screen.queryByTestId('lake-finding-assign-me-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('lake-finding-unassign-btn')).toBeInTheDocument();
  });

  // The route does not validate the assignee against the access view, so a refused picker must not
  // take the self-assign controls down with it.
  it('still allows self-assign when the assignee candidates are unavailable', () => {
    h.access.mockReturnValue({ data: { view: { grants: [] } } });
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    expect(screen.queryByTestId('lake-finding-assignee-select')).not.toBeInTheDocument();
    expect(screen.getByTestId('lake-finding-assign-me-btn')).toBeInTheDocument();
  });

  it('reads the access view only for a caller who can manage the lake', () => {
    render(
      <TestWrapper>
        <LakeFindingsDialog open onClose={vi.fn()} dataLakeId="lake-1" lakeName="Acme Policies" canManage={false} />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('lake-finding-row-finding-1'));

    expect(h.access).toHaveBeenCalledWith('lake-1', false);
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
    h.health.mockReturnValue({ data: { inconsistency: { computedAt: '2026-03-08T12:00:00Z' } } });
    renderDialog();

    expect(screen.getByTestId('lake-findings-empty')).toHaveTextContent(/after a scan/i);
    expect(screen.getByTestId('lake-findings-empty')).not.toHaveTextContent(/clean/i);
  });

  it('says a never-scanned lake has not been scanned yet in the empty state', () => {
    h.findings.mockReturnValue(listing([]));
    h.health.mockReturnValue({ data: { inconsistency: null } });
    renderDialog();

    expect(screen.getByTestId('lake-findings-empty')).toHaveTextContent(/not been scanned yet/i);
  });

  it('runs detection on this lake when Scan now is pressed', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('lake-findings-scan-btn'));

    expect(h.scanLakeId).toHaveBeenCalledWith('lake-1');
    expect(h.scan).toHaveBeenCalledTimes(1);
  });

  it('offers Scan now on an empty list, where a curator who just uploaded lands', () => {
    h.findings.mockReturnValue(listing([]));
    renderDialog();

    expect(screen.getByTestId('lake-findings-scan-btn')).toBeInTheDocument();
  });

  it('blocks a second scan while one is running', () => {
    h.scanPending.value = true;
    renderDialog();

    expect(screen.getByTestId('lake-findings-scan-btn')).toBeDisabled();
  });

  it('withholds Scan now when the findings read was refused', () => {
    h.findings.mockReturnValue(listing(undefined as unknown as IDataLakeFindingDocument[], { isForbidden: true }));
    renderDialog();

    expect(screen.queryByTestId('lake-findings-scan-btn')).not.toBeInTheDocument();
  });

  it('explains a permission refusal rather than painting an error', () => {
    h.findings.mockReturnValue(listing(undefined as unknown as IDataLakeFindingDocument[], { isForbidden: true }));
    renderDialog();

    expect(screen.getByTestId('lake-findings-forbidden')).toBeInTheDocument();
    expect(screen.queryByTestId('lake-findings-error')).not.toBeInTheDocument();
  });

  it('offers to load more when the route says there is another page', () => {
    h.findings.mockReturnValue(
      listing(
        Array.from({ length: 50 }, (_, i) => finding({ id: `finding-${i}` })),
        { hasMore: true }
      )
    );
    renderDialog();

    expect(screen.getByTestId('lake-findings-load-more')).toBeInTheDocument();
  });

  it('fetches the next page when load more is pressed', () => {
    const loadMore = vi.fn();
    h.findings.mockReturnValue(
      listing(
        Array.from({ length: 50 }, (_, i) => finding({ id: `finding-${i}` })),
        { hasMore: true, loadMore }
      )
    );
    renderDialog();

    fireEvent.click(screen.getByTestId('lake-findings-load-more'));

    expect(loadMore).toHaveBeenCalledTimes(1);
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
    expect(h.health).toHaveBeenCalledWith('lake-1', false);
  });

  const renderChip = () =>
    render(
      <TestWrapper>
        <LakeFindingsChip lakeId="lake-1" lakeName="Acme Policies" canManage />
      </TestWrapper>
    );

  it('says a never-scanned lake has not been scanned, rather than looking clean', () => {
    h.findings.mockReturnValue(listing([]));
    h.health.mockReturnValue({ data: { inconsistency: null } });
    renderChip();

    expect(screen.getByTestId('datalake-findings-chip-lake-1')).toHaveTextContent('Not scanned yet');
  });

  it('dates a scanned lake with no open findings', () => {
    h.findings.mockReturnValue(listing([]));
    h.health.mockReturnValue(scanned());
    renderChip();

    expect(screen.getByTestId('datalake-findings-chip-lake-1')).toHaveTextContent(
      `No open findings · checked ${formatFindingDate('2026-03-08T12:00:00Z')}`
    );
  });

  // A run that read zero members is the same "not clean" distinction one level down.
  it('does not call a run that read no documents clean', () => {
    h.findings.mockReturnValue(listing([]));
    h.health.mockReturnValue(scanned({ memberCount: 0 }));
    renderChip();

    const chip = screen.getByTestId('datalake-findings-chip-lake-1');
    expect(chip).toHaveTextContent('Nothing scanned');
    expect(chip).not.toHaveTextContent('No open findings');
  });

  // The open-findings query resolving to undefined (loading, or errored under `retry: false`) must
  // not read as an empty list - that would claim a lake with unknown open work is clean.
  it('stays on the bare label while the open-findings query has not resolved', () => {
    h.findings.mockReturnValue(listing(undefined as unknown as IDataLakeFindingDocument[]));
    h.health.mockReturnValue(scanned());
    renderChip();

    const chip = screen.getByTestId('datalake-findings-chip-lake-1');
    expect(chip).toHaveTextContent('Findings');
    expect(chip).not.toHaveTextContent('No open findings');
  });

  it('lets open findings outrank the last run state', () => {
    h.health.mockReturnValue(scanned());
    renderChip();

    expect(screen.getByTestId('datalake-findings-chip-lake-1')).toHaveTextContent('1 to review');
  });

  // Terminal-only history (e.g. one dismissed finding, zero open) must not take the entry point
  // down with it - the route still serves those rows, and a curator reaches them via the dialog's
  // own status filter. The chip stays up as a neutral, uncounted control instead of disappearing.
  it('stays reachable for a manager when only terminal-status findings exist', () => {
    h.findings.mockReturnValue(listing([]));
    render(
      <TestWrapper>
        <LakeFindingsChip lakeId="lake-1" lakeName="Acme Policies" canManage />
      </TestWrapper>
    );

    const chip = screen.getByTestId('datalake-findings-chip-lake-1');
    expect(chip).toHaveTextContent('Findings');

    fireEvent.click(within(chip).getByRole('button'));
    expect(screen.getByTestId('lake-findings-dialog')).toBeInTheDocument();
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

    expect(screen.getByTestId('datalake-findings-chip-lake-1')).toHaveTextContent('Findings');
    expect(screen.getByTestId('lake-findings-dialog')).toBeInTheDocument();
  });

  it('reads a fetched page as a lower bound when the route says there is more', () => {
    h.findings.mockReturnValue(listing([finding()], { hasMore: true }));
    render(
      <TestWrapper>
        <LakeFindingsChip lakeId="lake-1" lakeName="Acme Policies" canManage />
      </TestWrapper>
    );

    expect(screen.getByTestId('datalake-findings-chip-lake-1')).toHaveTextContent('1+ to review');
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
