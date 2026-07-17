import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ISourceUsage } from '@bike4mind/common';

const mockUseOrgUsage = vi.fn();

vi.mock('@client/app/hooks/data/organizations', () => ({
  useSearchOrganizations: () => ({ data: { data: [{ id: 'org-1', name: 'Acme' }] }, isLoading: false }),
}));
vi.mock('../hooks/useOrgUsage', () => ({
  useOrgUsage: (...args: unknown[]) => mockUseOrgUsage(...args),
}));

import { OrgUsageDashboard } from './OrgUsageDashboard';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const responseWith = (bySource: ISourceUsage[]) => ({
  organizationId: 'org-1',
  days: 30,
  overTime: [],
  byMember: [],
  byModel: [],
  byFeature: [],
  byApiKey: [],
  bySource,
  totals: { requests: 0, cogsUsd: 0, creditsCharged: 0 },
});

const setBySource = (bySource: ISourceUsage[]) => {
  mockUseOrgUsage.mockReturnValue({
    data: responseWith(bySource),
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  });
};

/** The tables only render once an org is picked, so open the select and take the first option. */
const renderAndSelectOrg = async () => {
  render(
    <TestWrapper>
      <OrgUsageDashboard />
    </TestWrapper>
  );
  const input = within(screen.getByTestId('org-usage-org-select')).getByRole('combobox');
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: 'Acme' }));
};

describe('OrgUsageDashboard by-source table', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a row per source with request counts and credits', async () => {
    setBySource([
      { source: 'cli', requests: 12, creditsSpent: 200 },
      { source: 'web', requests: 30, creditsSpent: 80 },
    ]);
    await renderAndSelectOrg();

    const table = await screen.findByTestId('org-usage-source-table');
    const rows = within(table).getAllByRole('row').slice(1); // drop the header
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('cli');
    expect(rows[0]).toHaveTextContent('12');
    expect(rows[1]).toHaveTextContent('web');
    expect(rows[1]).toHaveTextContent('30');
  });

  it('labels the residual bucket and preserves the server ordering that pins it last', async () => {
    // Server sorts unclassified last despite it outspending web; the table must not re-sort.
    setBySource([
      { source: 'web', requests: 1, creditsSpent: 5 },
      { source: 'unclassified', requests: 40, creditsSpent: 999 },
    ]);
    await renderAndSelectOrg();

    const table = await screen.findByTestId('org-usage-source-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('web');
    expect(rows[1]).toHaveTextContent('Unclassified');
    expect(within(table).queryByText('unclassified')).not.toBeInTheDocument();
  });

  it('shows an empty state when the window has no usage', async () => {
    setBySource([]);
    await renderAndSelectOrg();

    const table = await screen.findByTestId('org-usage-source-table');
    expect(within(table).getByText('No usage in this window.')).toBeInTheDocument();
  });
});
