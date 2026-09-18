import { IOrganizationDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useOrgFeedbackReport = vi.hoisted(() => vi.fn());
// The drill-down hooks come along transitively through the counts panel; the drill-down has its
// own test, and a mock factory that omits an export the module graph imports fails at load.
vi.mock('@client/app/hooks/data/orgFeedbackReport', () => ({
  useOrgFeedbackReport,
  useOrgFeedbackItems: vi.fn(() => ({ data: undefined, isFetching: false, isError: false, error: null })),
  useOrgFeedbackItem: vi.fn(() => ({ data: undefined, isFetching: false, isError: false, error: null })),
}));
// Stubbed to a marker: the panel has its own test, and it reaches the api and websocket contexts.
vi.mock('@client/app/components/organizations/OrgFeedbackSummaryPanel', () => ({
  default: () => <div data-testid="feedback-summary-panel" />,
}));

import OrganizationAnalysisSection from './OrganizationAnalysisSection';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const organization = { id: 'org1' } as IOrganizationDocument;

const REPORT = {
  range: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.999Z' },
  totals: { count: 3 },
  byDay: [{ day: '2026-01-10', count: 3 }],
  bySubject: [{ key: 'product', count: 3 }],
  byType: [{ key: 'bug', count: 3 }],
  byStatus: [{ key: 'new', count: 3 }],
  byTag: [{ key: 'billing', count: 2 }],
  byMember: [{ userId: 'u1', displayName: 'Alice', count: 3 }],
  membership: { memberCount: 2, aclOnly: [{ userId: 'u2', displayName: 'Bob' }], stampOnly: [] },
};

const state = (overrides: Record<string, unknown>) => ({
  data: undefined,
  isFetching: false,
  isError: false,
  error: null,
  ...overrides,
});

const renderSection = () =>
  render(
    <TestWrapper>
      <OrganizationAnalysisSection organization={organization} />
    </TestWrapper>
  );

const run = () => fireEvent.click(screen.getByTestId('org-analysis-run-button'));

describe('OrganizationAnalysisSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgFeedbackReport.mockReturnValue(state({ data: REPORT }));
  });

  it('defaults the draft window to exactly 30 calendar days, inclusive of both ends', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T15:00:00.000Z'));

    renderSection();

    expect(screen.getByTestId('org-analysis-date-from')).toHaveValue('2026-08-20');
    expect(screen.getByTestId('org-analysis-date-to')).toHaveValue('2026-09-18');

    vi.useRealTimers();
  });

  it('asks before it aggregates - nothing is fetched until the report is run', () => {
    renderSection();

    expect(screen.getByTestId('org-analysis-idle')).toBeInTheDocument();
    expect(screen.queryByTestId('org-analysis-counts')).not.toBeInTheDocument();
    expect(useOrgFeedbackReport).not.toHaveBeenCalled();
  });

  it('runs the window the caller picked, not the one they are still typing', () => {
    renderSection();

    fireEvent.change(screen.getByTestId('org-analysis-date-from'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByTestId('org-analysis-date-to'), { target: { value: '2026-01-31' } });
    expect(useOrgFeedbackReport).not.toHaveBeenCalled();

    run();

    expect(useOrgFeedbackReport).toHaveBeenCalledWith(
      'org1',
      { from: '2026-01-01', to: '2026-01-31' },
      { enabled: true }
    );
  });

  it('refuses to run an inverted range', () => {
    renderSection();

    fireEvent.change(screen.getByTestId('org-analysis-date-from'), { target: { value: '2026-03-01' } });
    fireEvent.change(screen.getByTestId('org-analysis-date-to'), { target: { value: '2026-02-01' } });

    expect(screen.getByTestId('org-analysis-range-error')).toBeInTheDocument();
    expect(screen.getByTestId('org-analysis-run-button')).toBeDisabled();
    run();
    expect(useOrgFeedbackReport).not.toHaveBeenCalled();
  });

  it('renders the counts and names the roster discrepancy behind them', () => {
    renderSection();
    run();

    expect(screen.getByTestId('org-analysis-total')).toHaveTextContent('3 reports from 1 contributors');
    expect(screen.getByTestId('org-analysis-by-member')).toHaveTextContent('Alice');
    expect(screen.getByTestId('org-analysis-acl-only')).toHaveTextContent('Bob');
    expect(screen.queryByTestId('org-analysis-stamp-only')).not.toBeInTheDocument();

    // The list is the User.organizationId pointer, not authorship, so someone credited in the
    // by-member table above can legitimately appear here too. Copy that denies authorship
    // contradicts that table for any owner whose pointer names their personal org.
    expect(screen.getByTestId('org-analysis-acl-only')).not.toHaveTextContent(/authoring nothing/i);
    expect(screen.getByTestId('org-analysis-acl-only')).toHaveTextContent(/points at another organization/i);
  });

  it('shows a spinner while fetching and an alert when the read fails', () => {
    useOrgFeedbackReport.mockReturnValue(state({ isFetching: true }));
    const { rerender } = renderSection();
    run();
    expect(screen.getByTestId('org-analysis-loading')).toBeInTheDocument();

    useOrgFeedbackReport.mockReturnValue(state({ isError: true, error: new Error('Organization not found') }));
    rerender(
      <TestWrapper>
        <OrganizationAnalysisSection organization={organization} />
      </TestWrapper>
    );
    expect(screen.getByTestId('org-analysis-error')).toHaveTextContent('Organization not found');
  });

  it('says so plainly when the window holds no feedback', () => {
    useOrgFeedbackReport.mockReturnValue(state({ data: { ...REPORT, totals: { count: 0 } } }));
    renderSection();
    run();

    expect(screen.getByTestId('org-analysis-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('org-analysis-counts')).not.toBeInTheDocument();
  });
});
