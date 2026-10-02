import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ApiKeyScope } from '@bike4mind/common';
import type { CreateUserApiKeyResponse, RotateCallbackSigningSecretResponse } from '@client/app/hooks/data/userApiKeys';
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
const keyWithSigningSecret = {
  id: 'key-3',
  name: 'Webhook key',
  scopes: [ApiKeyScope.AI_CHAT],
  status: 'active',
  keyPrefix: 'b4m_live_def',
  createdAt: new Date('2026-01-03'),
  callbackSigningSecretCreatedAt: new Date('2026-02-15'),
};

const h = vi.hoisted(() => ({
  keys: [] as any[],
  deleteMutate: vi.fn(),
  createResult: { key: 'b4m_live_newkey123' } as Partial<CreateUserApiKeyResponse>,
  signingSecretMutate: vi.fn(),
  signingSecretResult: {
    id: 'key-1',
    name: 'CI key',
    callbackSigningSecret: 'whsec_rotated999',
    callbackSigningSecretCreatedAt: new Date('2026-03-01'),
  } as RotateCallbackSigningSecretResponse,
}));

vi.mock('@client/app/hooks/data/userApiKeys', () => ({
  useGetUserApiKeys: () => ({ data: h.keys, isLoading: false, error: null, refetch: vi.fn() }),
  useCreateUserApiKey: ({ onSuccess }: { onSuccess?: (result: Partial<CreateUserApiKeyResponse>) => void } = {}) => ({
    mutate: () => onSuccess?.(h.createResult),
    isPending: false,
  }),
  useRotateUserApiKey: () => ({ mutate: vi.fn(), isPending: false }),
  useRevokeUserApiKey: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteUserApiKey: () => ({ mutate: h.deleteMutate, isPending: false }),
  useBillingOrganizations: () => ({ data: [], isLoading: false }),
  useRotateCallbackSigningSecret: ({
    onSuccess,
  }: { onSuccess?: (result: RotateCallbackSigningSecretResponse) => void } = {}) => ({
    mutate: (keyId: string) => {
      h.signingSecretMutate(keyId);
      onSuccess?.(h.signingSecretResult);
    },
    isPending: false,
  }),
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
    h.createResult = { key: 'b4m_live_newkey123' };
    h.signingSecretMutate.mockClear();
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

/**
 * The callback signing secret half of the table: per-key create/rotate action,
 * plus the one-time reveal shown after minting a key or its signing secret.
 */
describe('UserApiKeysTab - callback signing secret', () => {
  beforeEach(() => {
    h.keys = [];
    h.deleteMutate.mockClear();
    h.createResult = { key: 'b4m_live_newkey123' };
    h.signingSecretMutate.mockClear();
  });

  it('shows the signing secret in the one-time display after creating a key', () => {
    h.createResult = { key: 'b4m_live_newkey123', callbackSigningSecret: 'whsec_fresh123' };
    h.keys = [activeKey];
    renderTab();

    fireEvent.click(screen.getByText('Create API Key'));
    fireEvent.change(screen.getByTestId('api-key-name-input').querySelector('input')!, {
      target: { value: 'New key' },
    });
    fireEvent.click(screen.getByTestId('api-key-create-btn'));

    expect(screen.getByText('Callback Signing Secret')).toBeInTheDocument();
    expect(screen.getByText(/X-Webhook-Signature-256/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('project-api-keys-created-signing-secret-visibility-btn'));
    expect(screen.getByDisplayValue('whsec_fresh123')).toBeInTheDocument();
  });

  it('does not render a signing secret block when the create response lacks one', () => {
    h.createResult = { key: 'b4m_live_newkey123' };
    h.keys = [activeKey];
    renderTab();

    fireEvent.click(screen.getByText('Create API Key'));
    fireEvent.change(screen.getByTestId('api-key-name-input').querySelector('input')!, {
      target: { value: 'New key' },
    });
    fireEvent.click(screen.getByTestId('api-key-create-btn'));

    expect(screen.queryByText('Callback Signing Secret')).not.toBeInTheDocument();
  });

  it('offers "Create signing secret" for a key without one and "Rotate signing secret" for a key with one', () => {
    h.keys = [activeKey, keyWithSigningSecret];
    renderTab();

    expect(screen.getByTestId('api-key-signing-secret-action-key-1')).toHaveTextContent('Create signing secret');
    expect(screen.getByTestId('api-key-signing-secret-action-key-3')).toHaveTextContent('Rotate signing secret');
    expect(screen.getByTestId('api-key-signing-secret-status-key-1')).toHaveTextContent('No signing secret');
    expect(screen.getByTestId('api-key-signing-secret-status-key-3')).toHaveTextContent('Signing secret: created');
  });

  it('mints a signing secret immediately and shows it once for a key without one', () => {
    h.keys = [activeKey];
    renderTab();

    fireEvent.click(screen.getByTestId('api-key-signing-secret-action-key-1'));

    expect(h.signingSecretMutate).toHaveBeenCalledWith('key-1');
    expect(screen.getByText('Signing secret ready for CI key')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('project-api-keys-signing-secret-visibility-btn'));
    expect(screen.getByDisplayValue('whsec_rotated999')).toBeInTheDocument();
  });

  it('requires confirmation before rotating an existing signing secret', () => {
    h.keys = [keyWithSigningSecret];
    renderTab();

    fireEvent.click(screen.getByTestId('api-key-signing-secret-action-key-3'));
    expect(h.signingSecretMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('confirmation-dialog')).toHaveTextContent('Webhook key');

    fireEvent.click(screen.getByTestId('confirmation-confirm-btn'));
    expect(h.signingSecretMutate).toHaveBeenCalledWith('key-3');
  });
});
