import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AuditLogFilters } from '@bike4mind/common';
import { makeAuditEntry } from './shared/auditTestFixtures';
import AuditLogPage from './index';

const SINCE = '2026-09-19T00:00:00.000Z';

const mocks = vi.hoisted(() => ({
  setFilters: vi.fn(),
  patchFilters: vi.fn(),
  openEntry: vi.fn(),
  showSnackbar: vi.fn(),
  downloadAuditLogCsv: vi.fn(),
  refetch: vi.fn(),
  filters: {} as Record<string, string>,
  entryId: null as string | null,
  entries: [] as unknown[],
  listError: false,
  entryError: false,
  entryRefetchError: false,
  summaryError: false,
  criticalEntries: [] as unknown[],
  alertsEnabled: true,
}));

vi.mock('@client/app/hooks/data/adminAuditLog', () => ({
  useAuditLog: (filters: AuditLogFilters) => ({
    data: {
      pages: [{ entries: filters.severity === 'critical' ? mocks.criticalEntries : mocks.entries, nextCursor: null }],
    },
    isLoading: false,
    isError: mocks.listError,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: mocks.refetch,
  }),
  useAuditEntry: (id: string | null, initial: unknown) => ({
    data: id && (!mocks.entryError || mocks.entryRefetchError) ? initial : undefined,
    isError: id !== null && (mocks.entryError || mocks.entryRefetchError),
  }),
  useAuditSummary: () => ({
    isError: mocks.summaryError,
    data: mocks.summaryError
      ? undefined
      : {
          windowDays: 30,
          since: SINCE,
          creditGrants: {
            count: 3,
            grantedCredits: 12500,
            deductedCredits: 300,
            topGranters: [{ userId: 'u1', name: 'Alice', count: 2 }],
          },
          permissionChanges: 1,
          impersonations: 0,
          deletions: 2,
          deniedAttempts: 4,
        },
  }),
  useAuditAlertStatus: () => ({
    data: { alertsEnabled: mocks.alertsEnabled, singleGrantCredits: 50000, dailyGrantCredits: 200000 },
  }),
  downloadAuditLogCsv: mocks.downloadAuditLogCsv,
}));
vi.mock('./useAuditLogSearchParams', () => ({
  useAuditLogSearchParams: () => ({
    filters: mocks.filters as AuditLogFilters,
    entryId: mocks.entryId,
    setFilters: mocks.setFilters,
    patchFilters: mocks.patchFilters,
    openEntry: mocks.openEntry,
  }),
}));
vi.mock('@client/app/contexts/SnackbarContext', () => ({ useSnackbar: () => ({ showSnackbar: mocks.showSnackbar }) }));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useSearchOrganizations: () => ({ data: { data: [] }, isLoading: false }),
}));
vi.mock('@client/app/components/admin/shared/UserSelector', () => ({
  default: ({ label }: { label: string }) => <div data-testid={`mock-user-selector-${label}`} />,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('AuditLogPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.filters = {};
    mocks.entryId = null;
    mocks.entries = [makeAuditEntry({ id: 'e1' })];
    mocks.listError = false;
    mocks.entryError = false;
    mocks.entryRefetchError = false;
    mocks.summaryError = false;
    mocks.criticalEntries = [];
    mocks.alertsEnabled = true;
  });

  it('clicking a saved view sets its filters', () => {
    render(<AuditLogPage />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('audit-saved-view-credits'));
    expect(mocks.setFilters).toHaveBeenCalledWith({ category: 'credits' });
  });

  it('clicking a row opens the drawer via entryId', () => {
    render(<AuditLogPage />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('audit-table-row-e1'));
    expect(mocks.openEntry).toHaveBeenCalledWith('e1');
  });

  it('clicking a target filters by it', () => {
    render(<AuditLogPage />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('audit-table-target-filter-btn'));
    expect(mocks.patchFilters).toHaveBeenCalledWith({ targetKind: 'user', targetId: 'user-1' });
  });

  it('clicking the credit tile applies category credits and from = since', () => {
    render(<AuditLogPage />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('audit-summary-tile-credits'));
    expect(mocks.setFilters).toHaveBeenCalledWith({ category: 'credits', from: SINCE });
  });

  it('credit tile shows the granted total, grant count, deductions and top granters', () => {
    render(<AuditLogPage />, { wrapper: TestWrapper });
    const tile = screen.getByTestId('audit-summary-tile-credits');
    expect(tile.textContent).toContain('+12,500 credits');
    expect(tile.textContent).toContain('3 grants, -300 deducted: Alice (2)');
  });

  it('export shows the truncation notice when truncated', async () => {
    mocks.downloadAuditLogCsv.mockResolvedValue({ truncated: true });
    render(<AuditLogPage />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('audit-export-btn'));
    await waitFor(() => expect(mocks.showSnackbar).toHaveBeenCalledTimes(1));
    expect(mocks.showSnackbar.mock.calls[0][0]).toMatch(/50,000/);
  });

  it('shows an error snackbar when export rejects', async () => {
    mocks.downloadAuditLogCsv.mockRejectedValue(new Error('boom'));
    render(<AuditLogPage />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('audit-export-btn'));
    await waitFor(() =>
      expect(mocks.showSnackbar).toHaveBeenCalledWith(expect.any(String), { variant: 'soft', color: 'danger' })
    );
  });

  it('shows the empty state when there are no entries', () => {
    mocks.entries = [];
    render(<AuditLogPage />, { wrapper: TestWrapper });
    expect(screen.getByTestId('audit-table-empty')).toBeTruthy();
  });

  it('shows the list error instead of the empty state when the list query fails', () => {
    mocks.listError = true;
    mocks.entries = [];
    render(<AuditLogPage />, { wrapper: TestWrapper });
    expect(screen.getByTestId('audit-table-error')).toBeTruthy();
    expect(screen.queryByTestId('audit-table-empty')).toBeNull();
    fireEvent.click(within(screen.getByTestId('audit-table-error')).getByTestId('admin-error-retry-btn'));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows an inline error when the summary query fails', () => {
    mocks.summaryError = true;
    render(<AuditLogPage />, { wrapper: TestWrapper });
    expect(screen.getByTestId('audit-summary-error')).toBeTruthy();
  });

  it('clears entryId and warns when the linked entry cannot be loaded', () => {
    mocks.entryId = 'missing';
    mocks.entryError = true;
    render(<AuditLogPage />, { wrapper: TestWrapper });
    expect(mocks.openEntry).toHaveBeenCalledWith(null);
    expect(mocks.showSnackbar).toHaveBeenCalledWith(expect.any(String), { variant: 'soft', color: 'warning' });
  });

  it('keeps the drawer open when a background refetch of a loaded entry fails', () => {
    mocks.entryId = 'e1';
    mocks.entryRefetchError = true;
    render(<AuditLogPage />, { wrapper: TestWrapper });
    expect(screen.getByTestId('audit-drawer')).toBeTruthy();
    expect(mocks.openEntry).not.toHaveBeenCalled();
    expect(mocks.showSnackbar).not.toHaveBeenCalled();
  });

  it('shows the alerts-off banner only while the webhook is unset', () => {
    const { unmount } = render(<AuditLogPage />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('audit-alerts-off-banner')).toBeNull();
    unmount();

    mocks.alertsEnabled = false;
    render(<AuditLogPage />, { wrapper: TestWrapper });
    expect(screen.getByTestId('audit-alerts-off-banner').textContent).toMatch(/alerts are off/i);
  });

  it('keeps Needs review collapsed when nothing is critical, and opens it on demand', () => {
    render(<AuditLogPage />, { wrapper: TestWrapper });
    expect(screen.getByTestId('audit-needs-review-count').textContent).toBe('Nothing critical in 30 days');
    expect(screen.queryByTestId('audit-needs-review-table')).toBeNull();

    fireEvent.click(screen.getByTestId('audit-needs-review-toggle-btn'));
    expect(screen.getByTestId('audit-needs-review-table-empty')).toBeTruthy();
    expect(screen.getByTestId('audit-needs-review-panel').textContent).toContain('above 50,000 credits');
  });

  it('lists critical entries in Needs review and opens one in the shared drawer', () => {
    mocks.criticalEntries = [makeAuditEntry({ id: 'c1', severity: 'critical' })];
    render(<AuditLogPage />, { wrapper: TestWrapper });
    expect(screen.getByTestId('audit-needs-review-count').textContent).toBe('1 critical in 30 days');

    fireEvent.click(screen.getByTestId('audit-needs-review-table-row-c1'));
    expect(mocks.openEntry).toHaveBeenCalledWith('c1');
  });
});
