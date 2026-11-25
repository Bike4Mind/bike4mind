import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { CreditHolderType, type ISourceUsage, type IUsageDashboardResponse } from '@bike4mind/common';

const mockUseOwnerUsage = vi.fn();

vi.mock('@client/app/hooks/data/organizations', () => ({
  useSearchOrganizations: () => ({ data: { data: [{ id: 'org-1', name: 'Acme' }] }, isLoading: false }),
}));
vi.mock('../hooks/useOwnerUsage', () => ({
  useOwnerUsage: (...args: unknown[]) => mockUseOwnerUsage(...args),
}));

import { UsageDashboard } from './UsageDashboard';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const responseWith = (overrides: Partial<IUsageDashboardResponse>): IUsageDashboardResponse => ({
  ownerId: 'org-1',
  ownerType: CreditHolderType.Organization,
  days: 30,
  overTime: [],
  byMember: [],
  byProject: [],
  byModel: [],
  byFeature: [],
  byApiKey: [],
  bySource: [],
  ledger: { creditsCharged: 0, transactions: 0 },
  totals: { requests: 0, cogsUsd: 0, creditsCharged: 0 },
  ...overrides,
});

const setData = (overrides: Partial<IUsageDashboardResponse>) => {
  mockUseOwnerUsage.mockReturnValue({
    data: responseWith(overrides),
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  });
};

/** In admin org-picker mode the tables only render once an org is picked. */
const renderAndSelectOrg = async () => {
  render(
    <TestWrapper>
      <UsageDashboard ownerType={CreditHolderType.Organization} />
    </TestWrapper>
  );
  const input = within(screen.getByTestId('usage-org-select')).getByRole('combobox');
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: 'Acme' }));
};

describe('UsageDashboard by-source table', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a row per source with request counts and credits', async () => {
    setData({
      bySource: [
        { source: 'cli', requests: 12, creditsSpent: 200 },
        { source: 'web', requests: 30, creditsSpent: 80 },
      ] as ISourceUsage[],
    });
    await renderAndSelectOrg();

    const table = await screen.findByTestId('usage-source-table');
    const rows = within(table).getAllByRole('row').slice(1); // drop the header
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('cli');
    expect(rows[0]).toHaveTextContent('12');
    expect(rows[1]).toHaveTextContent('web');
    expect(rows[1]).toHaveTextContent('30');
  });

  it('labels the residual bucket and preserves the server ordering that pins it last', async () => {
    // Server sorts unclassified last despite it outspending web; the table must not re-sort.
    setData({
      bySource: [
        { source: 'web', requests: 1, creditsSpent: 5 },
        { source: 'unclassified', requests: 40, creditsSpent: 999 },
      ] as ISourceUsage[],
    });
    await renderAndSelectOrg();

    const table = await screen.findByTestId('usage-source-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('web');
    expect(rows[1]).toHaveTextContent('Unclassified');
    expect(within(table).queryByText('unclassified')).not.toBeInTheDocument();
  });

  it('shows an empty state when the window has no usage', async () => {
    setData({ bySource: [] });
    await renderAndSelectOrg();

    expect((await screen.findAllByText('No usage in this window.')).length).toBeGreaterThan(0);
  });
});

describe('UsageDashboard owner type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the by-member cut for an Organization owner', async () => {
    setData({ byMember: [{ userId: 'u1', userName: 'Ada', requests: 3, cogsUsd: 0, creditsCharged: 9 }] });
    await renderAndSelectOrg();
    expect(await screen.findByTestId('usage-member-table')).toBeInTheDocument();
  });

  it('shows persisted project IDs and explicitly Unassigned history', async () => {
    setData({
      byProject: [
        { projectId: 'project-1', requests: 2, cogsUsd: 0.1, creditsCharged: 20 },
        { projectId: null, requests: 1, cogsUsd: 0.05, creditsCharged: 10 },
      ],
    });
    await renderAndSelectOrg();
    const table = screen.getByTestId('usage-project-table');
    expect(within(table).getByText('project-1')).toBeInTheDocument();
    expect(within(table).getByText('Unassigned')).toBeInTheDocument();
    expect(screen.getByTestId('usage-export-btn')).toBeEnabled();
  });

  it('does not export cached data for a different selected period', () => {
    setData({ days: 30 });
    render(
      <TestWrapper>
        <UsageDashboard ownerType={CreditHolderType.Organization} ownerId="org-1" days={7} />
      </TestWrapper>
    );
    expect(screen.getByTestId('usage-export-btn')).toBeDisabled();
  });

  it('hides the by-member cut for a User owner and shows no org picker', () => {
    setData({ ownerType: CreditHolderType.User, ownerId: 'user-1' });
    render(
      <TestWrapper>
        <UsageDashboard ownerType={CreditHolderType.User} ownerId="user-1" />
      </TestWrapper>
    );
    expect(screen.queryByTestId('usage-member-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('usage-org-select')).not.toBeInTheDocument();
    expect(screen.getByText('By source')).toBeInTheDocument();
  });
});

describe('UsageDashboard ledger reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderUser = (days?: number) =>
    render(
      <TestWrapper>
        <UsageDashboard ownerType={CreditHolderType.User} ownerId="user-1" days={days} reconcileLedger />
      </TestWrapper>
    );

  it('shows the ledger total and an Other charges row when there are no usage events', () => {
    setData({
      ownerType: CreditHolderType.User,
      ownerId: 'user-1',
      totals: { requests: 0, cogsUsd: 0, creditsCharged: 0 },
      ledger: { creditsCharged: 5069, transactions: 12 },
    });
    renderUser();

    expect(screen.getByTestId('usage-total-credits')).toHaveTextContent('5,069 credits');
    const table = screen.getByTestId('usage-feature-table');
    expect(within(table).getByText('Other charges (no per-call detail)')).toBeInTheDocument();
    expect(within(table).getByText('5,069')).toBeInTheDocument();
    expect(screen.getByTestId('usage-residual-note')).toBeInTheDocument();
    expect(screen.getByTestId('usage-no-events-note')).toBeInTheDocument();
    const modelTable = screen.getByTestId('usage-model-table');
    expect(within(modelTable).queryByText('No usage in this window.')).not.toBeInTheDocument();
    expect(within(modelTable).getByText("No per-call detail for this window's charges.")).toBeInTheDocument();
    expect(screen.getByText(/appear as Other charges/)).toBeInTheDocument();
    expect(screen.getByText('No metered AI usage in this window.')).toBeInTheDocument();
    expect(screen.getByText(/Metered AI usage only/)).toBeInTheDocument();
  });

  it('adds no residual row when events and ledger agree', () => {
    setData({
      ownerType: CreditHolderType.User,
      ownerId: 'user-1',
      byFeature: [{ feature: 'agent_execution', requests: 4, cogsUsd: 0.2, creditsCharged: 1000 }],
      totals: { requests: 4, cogsUsd: 0.2, creditsCharged: 1000 },
      ledger: { creditsCharged: 1000, transactions: 4 },
    });
    renderUser();

    const table = screen.getByTestId('usage-feature-table');
    expect(within(table).getByText('Agent runs')).toBeInTheDocument();
    expect(within(table).queryByText(/Other charges/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('usage-residual-note')).not.toBeInTheDocument();
  });

  it('hides its own range toggle and requests the controlled window', () => {
    setData({ ownerType: CreditHolderType.User, ownerId: 'user-1' });
    renderUser(7);

    expect(screen.queryByTestId('admin-filter-bar')).not.toBeInTheDocument();
    expect(mockUseOwnerUsage).toHaveBeenCalledWith(CreditHolderType.User, 'user-1', 7);
  });

  it('keeps its own range toggle when uncontrolled', () => {
    setData({ ownerType: CreditHolderType.User, ownerId: 'user-1' });
    renderUser();
    expect(screen.getByTestId('admin-filter-days')).toBeInTheDocument();
  });

  it('keeps the posted ledger total and explains larger per-call detail', () => {
    setData({
      ownerType: CreditHolderType.User,
      ownerId: 'user-1',
      byFeature: [{ feature: 'agent_execution', requests: 4, cogsUsd: 0.2, creditsCharged: 1050 }],
      totals: { requests: 4, cogsUsd: 0.2, creditsCharged: 1050 },
      ledger: { creditsCharged: 1000, transactions: 4 },
    });
    renderUser();

    expect(screen.getByTestId('usage-total-credits')).toHaveTextContent('1,000 credits');
    expect(screen.getByTestId('usage-ledger-detail-note')).toHaveTextContent(
      'Per-call records total 1,050 credits, above the posted ledger total of 1,000 credits.'
    );
    expect(screen.queryByTestId('usage-residual-note')).not.toBeInTheDocument();
  });

  it('keeps a real sub-credit ledger charge visible', () => {
    setData({ ownerType: CreditHolderType.User, ownerId: 'user-1', ledger: { creditsCharged: 0.6, transactions: 1 } });
    renderUser();
    expect(screen.getByTestId('usage-total-credits')).toHaveTextContent('<1 credits');
    expect(screen.getByTestId('usage-no-events-note')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('usage-feature-table')).getByText('Other charges (no per-call detail)')
    ).toBeInTheDocument();
  });

  it('explains why the daily chart omits ledger-only charges', () => {
    setData({
      ownerType: CreditHolderType.User,
      ownerId: 'user-1',
      totals: { requests: 1, cogsUsd: 0, creditsCharged: 50 },
      ledger: { creditsCharged: 100, transactions: 2 },
    });
    renderUser();
    expect(screen.getByTestId('usage-chart-detail-note')).toHaveTextContent(
      'Chart covers charges with a per-call record only.'
    );
  });

  it('leaves an organization dashboard on usage events only, even with ledger spend', () => {
    setData({ ledger: { creditsCharged: 2000, transactions: 1 } });
    render(
      <TestWrapper>
        <UsageDashboard ownerType={CreditHolderType.Organization} ownerId="org-1" />
      </TestWrapper>
    );

    expect(screen.getByTestId('usage-total-credits')).toHaveTextContent('0 credits');
    expect(screen.getAllByText('No usage in this window.').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Metered AI usage only/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('usage-residual-note')).not.toBeInTheDocument();
    expect(screen.queryByText(/Other charges \(no per-call/)).not.toBeInTheDocument();
    expect(screen.queryByText(/appear as Other charges/)).not.toBeInTheDocument();
  });
});
