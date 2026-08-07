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

const makeUser = (id: string, name: string): WithOrgRef<IUserDocument> =>
  ({
    id,
    name,
    email: `${name.toLowerCase()}@example.com`,
    storageLimit: 1024,
    currentStorageSize: 0,
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
});
