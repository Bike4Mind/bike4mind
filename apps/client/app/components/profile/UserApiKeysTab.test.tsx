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
  createMutate: vi.fn(),
  signingSecretMutate: vi.fn(),
  signingSecretResult: {
    id: 'key-1',
    name: 'CI key',
    callbackSigningSecret: 'whsec_rotated999',
    callbackSigningSecretCreatedAt: new Date('2026-03-01'),
  } as RotateCallbackSigningSecretResponse,
  hasOptiAccess: false,
}));

vi.mock('@client/app/hooks/data/opti', () => ({ useOptiAccess: () => h.hasOptiAccess }));

vi.mock('@client/app/hooks/data/userApiKeys', () => ({
  useGetUserApiKeys: () => ({ data: h.keys, isLoading: false, error: null, refetch: vi.fn() }),
  useCreateUserApiKey: ({ onSuccess }: { onSuccess?: (result: Partial<CreateUserApiKeyResponse>) => void } = {}) => ({
    mutate: (data: unknown) => {
      h.createMutate(data);
      onSuccess?.(h.createResult);
    },
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

  it('shows a runnable test snippet that uses this origin and a Bearer header without repeating the key', () => {
    h.keys = [activeKey];
    renderTab();

    fireEvent.click(screen.getByText('Create API Key'));
    fireEvent.change(screen.getByTestId('api-key-name-input').querySelector('input')!, {
      target: { value: 'New key' },
    });
    fireEvent.click(screen.getByTestId('api-key-create-btn'));

    const snippet = screen.getByTestId('api-key-created-snippet').textContent!;
    expect(snippet).toContain(`${window.location.origin}/api/chat`);
    expect(snippet).toContain('-H "Authorization: Bearer $B4M_API_KEY"');
    expect(snippet).not.toContain('X-API-Key');
    expect(snippet).not.toContain('your-deployment.example.com');
    expect(snippet).not.toContain('b4m_live_newkey123');
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

describe('UserApiKeysTab - API docs links', () => {
  // Relative on purpose: each deployment (preview, self-host) serves its own spec.
  const expectSameOriginDocsLink = (element: HTMLElement) => {
    expect(element).toHaveAttribute('href', '/api/v1/docs');
    expect(element).toHaveAttribute('target', '_blank');
    expect(element.getAttribute('rel')).toContain('noopener');
  };

  beforeEach(() => {
    h.keys = [activeKey];
  });

  it('links the header API Docs button to the same-origin docs', () => {
    renderTab();

    expectSameOriginDocsLink(screen.getByTestId('api-keys-open-docs-btn'));
  });

  it('links the API Documentation tab to the same-origin docs', () => {
    renderTab();
    fireEvent.click(screen.getByText('API Documentation'));

    expectSameOriginDocsLink(screen.getByTestId('api-keys-docs-reference-link'));
  });
});

describe('UserApiKeysTab - premium scopes', () => {
  const PREMIUM = [ApiKeyScope.OPTIHASHI_READ, ApiKeyScope.OPTIHASHI_COMPUTE];
  const openScopeDocs = () => {
    renderTab();
    fireEvent.click(screen.getByText('API Documentation'));
    fireEvent.click(screen.getByText('Scopes'));
    // Anchors the negative case: the scope list itself rendered.
    expect(screen.getByText(ApiKeyScope.AI_CHAT)).toBeInTheDocument();
  };

  beforeEach(() => {
    h.keys = [activeKey];
    h.hasOptiAccess = false;
    h.createMutate.mockClear();
  });

  it('keeps the premium scopes out of the New-Key modal and its Full access preset without Opti access', () => {
    renderTab();
    fireEvent.click(screen.getByText('Create API Key'));
    expect(screen.getByTestId(`api-key-scope-${ApiKeyScope.AI_CHAT}`)).toBeInTheDocument();
    for (const scope of PREMIUM) expect(screen.queryByTestId(`api-key-scope-${scope}`)).toBeNull();

    // Joy puts a clickable Chip's onClick on its inner action button.
    fireEvent.click(screen.getByTestId('api-key-preset-full').querySelector('button')!);
    fireEvent.change(screen.getByTestId('api-key-name-input').querySelector('input')!, {
      target: { value: 'Full key' },
    });
    fireEvent.click(screen.getByTestId('api-key-create-btn'));

    const { scopes } = h.createMutate.mock.calls[0][0] as { scopes: ApiKeyScope[] };
    expect(scopes).toContain(ApiKeyScope.AI_CHAT);
    for (const scope of PREMIUM) expect(scopes).not.toContain(scope);
  });

  it('re-seeds the Read-only default when Opti access resolves after mount', () => {
    const view = renderTab();
    h.hasOptiAccess = true;
    view.rerender(
      <CssVarsProvider theme={appTheme}>
        <UserApiKeysTab />
      </CssVarsProvider>
    );
    fireEvent.click(screen.getByText('Create API Key'));
    fireEvent.change(screen.getByTestId('api-key-name-input').querySelector('input')!, {
      target: { value: 'Read key' },
    });
    fireEvent.click(screen.getByTestId('api-key-create-btn'));

    const { scopes } = h.createMutate.mock.calls[0][0] as { scopes: ApiKeyScope[] };
    expect(scopes).toContain(ApiKeyScope.OPTIHASHI_READ);
    expect(scopes).not.toContain(ApiKeyScope.OPTIHASHI_COMPUTE);
  });

  const rerenderTab = (view: ReturnType<typeof renderTab>) =>
    view.rerender(
      <CssVarsProvider theme={appTheme}>
        <UserApiKeysTab />
      </CssVarsProvider>
    );

  const submitKey = (name: string) => {
    fireEvent.change(screen.getByTestId('api-key-name-input').querySelector('input')!, { target: { value: name } });
    fireEvent.click(screen.getByTestId('api-key-create-btn'));
    return (h.createMutate.mock.calls[0][0] as { scopes: ApiKeyScope[] }).scopes;
  };

  it('drops the premium scopes from a Full access selection when Opti access is revoked', () => {
    h.hasOptiAccess = true;
    const view = renderTab();
    fireEvent.click(screen.getByText('Create API Key'));
    fireEvent.click(screen.getByTestId('api-key-preset-full').querySelector('button')!);
    h.hasOptiAccess = false;
    rerenderTab(view);

    const scopes = submitKey('Revoked key');
    expect(scopes).toContain(ApiKeyScope.AI_CHAT);
    for (const scope of PREMIUM) expect(scopes).not.toContain(scope);
  });

  it('drops the premium scopes from a custom selection when Opti access is revoked', () => {
    h.hasOptiAccess = true;
    const view = renderTab();
    fireEvent.click(screen.getByText('Create API Key'));
    // Read-only plus one extra scope: a custom set that still holds optihashi:read.
    fireEvent.click(screen.getByTestId(`api-key-scope-${ApiKeyScope.AI_CHAT}`).querySelector('button')!);
    h.hasOptiAccess = false;
    rerenderTab(view);

    const scopes = submitKey('Revoked custom key');
    expect(scopes).toContain(ApiKeyScope.AI_CHAT);
    for (const scope of PREMIUM) expect(scopes).not.toContain(scope);
  });

  it('keeps a custom selection when Opti access resolves after the user picked scopes', () => {
    const view = renderTab();
    fireEvent.click(screen.getByText('Create API Key'));
    fireEvent.click(screen.getByTestId(`api-key-scope-${ApiKeyScope.AI_CHAT}`).querySelector('button')!);
    h.hasOptiAccess = true;
    rerenderTab(view);

    const scopes = submitKey('Custom key');
    expect(scopes).toContain(ApiKeyScope.AI_CHAT);
    for (const scope of PREMIUM) expect(scopes).not.toContain(scope);
  });

  it('leaves the premium scopes out of the scope docs without Opti access', () => {
    openScopeDocs();
    for (const scope of PREMIUM) expect(screen.queryByText(scope)).toBeNull();
  });

  it('documents the premium scopes with Opti access', () => {
    h.hasOptiAccess = true;
    openScopeDocs();
    for (const scope of PREMIUM) expect(screen.getByText(scope)).toBeInTheDocument();
  });
});
