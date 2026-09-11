import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ApiKeyScope } from '@bike4mind/common';
import UserApiKeysTab from './UserApiKeysTab';

/**
 * The revoked-key hygiene half of the table: revoked rows are hidden behind a
 * default-off toggle, and delete is reachable only once a key is revoked (the
 * UI half of the delete route's revoked-only rule).
 */

const activeKey = {
  id: 'key-1',
  name: 'CI key',
  scopes: [ApiKeyScope.AI_CHAT],
  status: 'active',
  keyPrefix: 'b4m_live_abc',
  createdAt: new Date('2026-01-01'),
};
const revokedKey = {
  id: 'key-2',
  name: 'Old CI key',
  scopes: [ApiKeyScope.AI_CHAT],
  status: 'disabled',
  keyPrefix: 'b4m_live_xyz',
  createdAt: new Date('2026-01-02'),
  revokedAt: new Date('2026-02-01'),
};

const h = vi.hoisted(() => ({
  keys: [] as any[],
  deleteMutate: vi.fn(),
}));

vi.mock('@client/app/hooks/data/userApiKeys', () => ({
  useGetUserApiKeys: () => ({ data: h.keys, isLoading: false, error: null, refetch: vi.fn() }),
  useCreateUserApiKey: () => ({ mutate: vi.fn(), isPending: false }),
  useRotateUserApiKey: () => ({ mutate: vi.fn(), isPending: false }),
  useRevokeUserApiKey: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteUserApiKey: () => ({ mutate: h.deleteMutate, isPending: false }),
  useBillingOrganizations: () => ({ data: [], isLoading: false }),
}));

vi.mock('@client/app/hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({ copied: false, handleCopyToClipboard: vi.fn() }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <UserApiKeysTab />
    </CssVarsProvider>
  );

describe('UserApiKeysTab - revoked keys', () => {
  beforeEach(() => {
    h.keys = [];
    h.deleteMutate.mockClear();
  });

  it('hides revoked rows by default and counts them on the toggle', () => {
    h.keys = [activeKey, revokedKey];
    renderTab();

    expect(screen.getByText('CI key')).toBeInTheDocument();
    expect(screen.queryByText('Old CI key')).not.toBeInTheDocument();
    expect(screen.getByText('Show revoked (1)')).toBeInTheDocument();
  });

  it('reveals revoked rows when the toggle is turned on', () => {
    h.keys = [activeKey, revokedKey];
    renderTab();

    fireEvent.click(screen.getByTestId('api-keys-show-revoked'));

    expect(screen.getByText('Old CI key')).toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
  });

  it('offers no toggle when nothing is revoked', () => {
    h.keys = [activeKey];
    renderTab();

    expect(screen.queryByTestId('api-keys-show-revoked')).not.toBeInTheDocument();
  });

  // Hiding every row would otherwise read as "you have no keys", which is the
  // one thing the empty state must not say while keys still exist.
  it('explains an all-revoked list instead of rendering an empty table', () => {
    h.keys = [revokedKey];
    renderTab();

    expect(screen.getByTestId('api-keys-all-revoked')).toBeInTheDocument();
    expect(screen.queryByText('Old CI key')).not.toBeInTheDocument();
    expect(screen.getByTestId('api-keys-show-revoked')).toBeInTheDocument();
  });

  it('keeps delete disabled for an active key', () => {
    h.keys = [activeKey];
    renderTab();

    expect(screen.getByTestId('api-key-delete-key-1')).toBeDisabled();
  });

  it('deletes a revoked key only after the confirmation is accepted', () => {
    h.keys = [activeKey, revokedKey];
    renderTab();
    fireEvent.click(screen.getByTestId('api-keys-show-revoked'));

    fireEvent.click(screen.getByTestId('api-key-delete-key-2'));
    expect(h.deleteMutate).not.toHaveBeenCalled();
    // The dialog names the key, so a mis-wired row can't confirm the wrong one.
    expect(screen.getByTestId('confirmation-dialog')).toHaveTextContent('Old CI key');

    fireEvent.click(screen.getByTestId('confirmation-confirm-btn'));
    expect(h.deleteMutate).toHaveBeenCalledWith('key-2');
  });
});
