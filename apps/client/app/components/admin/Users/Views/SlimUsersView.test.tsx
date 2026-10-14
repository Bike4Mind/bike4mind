import type { IUserDocument, WithOrgRef } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsMobile = vi.fn(() => false);

vi.mock('@client/app/hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile(),
  useIsTablet: () => false,
}));

vi.mock('@client/app/hooks/data/user', () => ({
  useGetRecentActivities: () => ({ data: [] }),
  useGetUserActivityCounters: () => ({ data: [] }),
  useGetUser: () => ({ data: undefined, isLoading: false }),
}));

import SlimUsersContainer from './SlimUsersView';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const makeUser = (
  id: string,
  name: string,
  storage: { storageLimit: number; currentStorageSize: number } = { storageLimit: 1000, currentStorageSize: 0 }
): WithOrgRef<IUserDocument> =>
  ({
    id,
    name,
    email: `${name.toLowerCase()}@example.com`,
    ...storage,
    loginRecords: [],
  }) as unknown as WithOrgRef<IUserDocument>;

const users = [makeUser('6900781a8c1b76a684f80001', 'Ada'), makeUser('68f727e8e537d08a1af4dacf', 'Grace')];

beforeEach(() => {
  mockIsMobile.mockReset().mockReturnValue(false);
  Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
});

describe('SlimUsersContainer', () => {
  it('renders the column header and one row per user on desktop', () => {
    render(<SlimUsersContainer users={users} />, { wrapper: TestWrapper });

    expect(screen.getByText('Recent Activity')).toBeInTheDocument();
    expect(screen.getAllByTestId('admin-user-card')).toHaveLength(2);
    expect(screen.getByTestId('user-name-Ada')).toBeInTheDocument();
  });

  it('drops the column header on mobile and still renders one card per user', () => {
    mockIsMobile.mockReturnValue(true);
    render(<SlimUsersContainer users={users} />, { wrapper: TestWrapper });

    // The header row is table chrome; the stacked cards replace it entirely.
    expect(screen.queryByText('Recent Activity')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('admin-user-card')).toHaveLength(2);
    expect(screen.getByTestId('user-name-Grace')).toBeInTheDocument();
  });

  it('keeps user rows free of the horizontal scroll that broke the mobile layout', () => {
    mockIsMobile.mockReturnValue(true);
    render(<SlimUsersContainer users={users} />, { wrapper: TestWrapper });

    for (const card of screen.getAllByTestId('admin-user-card')) {
      const styles = getComputedStyle(card);
      expect(styles.overflowX).not.toBe('auto');
      expect(styles.minWidth).not.toBe('800px');
    }
  });

  it('exposes exactly one admin action pair per user in each layout', () => {
    const { unmount } = render(<SlimUsersContainer users={users} />, { wrapper: TestWrapper });
    expect(screen.getAllByTestId('admin-user-admin-btn')).toHaveLength(2);
    expect(screen.getAllByTestId('admin-user-profile-btn')).toHaveLength(2);
    unmount();

    mockIsMobile.mockReturnValue(true);
    render(<SlimUsersContainer users={users} />, { wrapper: TestWrapper });
    expect(screen.getAllByTestId('admin-user-admin-btn')).toHaveLength(2);
    expect(screen.getAllByTestId('admin-user-profile-btn')).toHaveLength(2);
  });

  describe('storage cell', () => {
    const renderStorageCell = (storageLimit: number, currentStorageSize: number) => {
      render(
        <SlimUsersContainer
          users={[makeUser('6900781a8c1b76a684f80001', 'Ada', { storageLimit, currentStorageSize })]}
        />,
        { wrapper: TestWrapper }
      );
      return {
        cell: screen.getByTestId('admin-user-storage-cell'),
        label: screen.getByTestId('admin-user-storage-cell-label'),
        progress: screen.getByTestId('admin-user-storage-cell-progress'),
      };
    };

    // 920,000,000 of a 1000 MB limit is 92% to enforcement, which reads storageLimit as decimal MB.
    it('shows the decimal-MB limit in the tooltip and the matching percentage', () => {
      const { cell, label, progress } = renderStorageCell(1000, 920_000_000);
      expect(cell).toHaveAttribute('aria-label', '920 MB / 1 GB');
      expect(label).toHaveTextContent('92%');
      expect(progress.className).toContain('MuiLinearProgress-colorDanger');
    });

    it('reads a zero limit as full, as the detail view does', () => {
      const { label, progress } = renderStorageCell(0, 500_000_000);
      expect(label).toHaveTextContent('100%');
      expect(progress).toHaveAttribute('aria-valuenow', '100');
      expect(progress.className).toContain('MuiLinearProgress-colorDanger');
    });
  });
});
