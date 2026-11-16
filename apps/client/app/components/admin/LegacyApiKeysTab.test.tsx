import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IAdminLegacyApiKeys } from '@bike4mind/common';

const { mockUseAdminLegacyApiKeys } = vi.hoisted(() => ({ mockUseAdminLegacyApiKeys: vi.fn() }));
vi.mock('@client/app/hooks/data/adminLegacyApiKeys', () => ({
  useAdminLegacyApiKeys: mockUseAdminLegacyApiKeys,
}));

import LegacyApiKeysTab from './LegacyApiKeysTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <LegacyApiKeysTab />
    </CssVarsProvider>
  );

const result = (over: Partial<IAdminLegacyApiKeys> = {}): IAdminLegacyApiKeys => ({
  rows: [
    {
      keyId: 'k1',
      name: 'Build bot',
      keyPrefix: 'b4m_live_abc',
      userId: 'u1',
      ownerEmail: 'owner@example.com',
      createdAt: '2026-06-01T00:00:00.000Z',
      lastUsedAt: '2026-11-10T00:00:00.000Z',
    },
  ],
  page: 1,
  limit: 25,
  total: 1,
  ownerCount: 1,
  usedWithinDays: 30,
  cutoff: null,
  endsAt: null,
  ...over,
});

const state = (over: Record<string, unknown> = {}) => ({
  data: result(),
  isPending: false,
  isError: false,
  isFetching: false,
  isPlaceholderData: false,
  refetch: vi.fn(),
  ...over,
});

describe('LegacyApiKeysTab', () => {
  beforeEach(() => {
    mockUseAdminLegacyApiKeys.mockReset();
    mockUseAdminLegacyApiKeys.mockReturnValue(state());
  });

  it('lists each legacy key with its owner', () => {
    renderTab();

    const row = screen.getByTestId('admin-legacy-api-key-row-k1');
    expect(row).toHaveTextContent('owner@example.com');
    expect(row).toHaveTextContent('Build bot');
    expect(row).toHaveTextContent('b4m_live_abc');
  });

  it('starts on the first page of the last 30 days', () => {
    renderTab();

    expect(mockUseAdminLegacyApiKeys).toHaveBeenLastCalledWith({ page: 1, limit: 25, days: 30 });
  });

  it('refetches for the chosen usage window', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('admin-legacy-api-keys-window-90'));

    expect(mockUseAdminLegacyApiKeys).toHaveBeenLastCalledWith({ page: 1, limit: 25, days: 90 });
  });

  it('says the window dates are not set yet rather than showing a blank', () => {
    renderTab();

    expect(screen.getAllByText('Not set')).toHaveLength(2);
  });

  it('offers a refresh when no legacy key was used', () => {
    mockUseAdminLegacyApiKeys.mockReturnValue(state({ data: result({ rows: [], total: 0, ownerCount: 0 }) }));
    renderTab();

    expect(screen.getByTestId('admin-legacy-api-keys-refresh-btn')).toBeInTheDocument();
  });
});
