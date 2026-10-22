import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import OrganizationStorageUsage from './OrganizationStorageUsage';

const mockUseOrgStorageUsage = vi.fn();
vi.mock('@client/app/hooks/data/useOrgStorageUsage', () => ({
  useOrgStorageUsage: (orgId: string) => mockUseOrgStorageUsage(orgId),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPanel = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <OrganizationStorageUsage organizationId="o1" />
    </CssVarsProvider>
  );

beforeEach(() => {
  mockUseOrgStorageUsage.mockReset();
});

describe('OrganizationStorageUsage', () => {
  it('shows the pool against its limit and each uploader', () => {
    mockUseOrgStorageUsage.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        organizationId: 'o1',
        usedBytes: 3_000_000,
        limitBytes: 10_000_000,
        uploaders: [
          { userId: 'u1', name: 'Alice', email: 'a@example.com', bytes: 2_000_000, fileCount: 2 },
          { userId: 'u2', name: null, email: null, bytes: 1_000_000, fileCount: 1 },
        ],
        uploadersTruncated: true,
      },
    });

    renderPanel();

    expect(mockUseOrgStorageUsage).toHaveBeenCalledWith('o1');
    expect(screen.getByTestId('org-storage-usage-total').textContent).toBe('3 MB of 10 MB used');
    const rows = screen.getAllByTestId('org-storage-usage-uploader');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Alice');
    expect(rows[0].textContent).toContain('(2 files)');
    expect(rows[1].textContent).toContain('Deleted user');
    expect(screen.getByText('Showing the 2 largest uploaders.')).toBeTruthy();
  });

  it('offers a retry when the request fails', () => {
    const refetch = vi.fn();
    mockUseOrgStorageUsage.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch });

    renderPanel();
    screen.getByTestId('org-storage-usage-retry-btn').click();

    expect(refetch).toHaveBeenCalled();
  });

  it('shows a full bar when the limit is zero but storage is used', () => {
    mockUseOrgStorageUsage.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { organizationId: 'o1', usedBytes: 5_000_000, limitBytes: 0, uploaders: [], uploadersTruncated: false },
    });

    renderPanel();

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });
});
