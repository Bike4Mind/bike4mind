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
  byModel: [],
  byFeature: [],
  byApiKey: [],
  bySource: [],
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

    const table = await screen.findByTestId('usage-source-table');
    expect(within(table).getByText('No usage in this window.')).toBeInTheDocument();
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

  it('hides the by-member cut for a User owner and shows no org picker', () => {
    setData({ ownerType: CreditHolderType.User, ownerId: 'user-1' });
    render(
      <TestWrapper>
        <UsageDashboard ownerType={CreditHolderType.User} ownerId="user-1" />
      </TestWrapper>
    );
    expect(screen.queryByTestId('usage-member-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('usage-org-select')).not.toBeInTheDocument();
    expect(screen.getByTestId('usage-source-table')).toBeInTheDocument();
  });
});
