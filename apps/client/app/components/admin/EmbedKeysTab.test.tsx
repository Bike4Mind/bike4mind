import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ApiKeyScope } from '@bike4mind/common';
import EmbedKeysTab from './EmbedKeysTab';

// A stored embed key carrying a plan-gated `hideBranding` the form never exposes -
// the fixture that proves a no-op Configure-save can't clobber it.
const embedKey = {
  id: 'key-1',
  name: 'Acme widget',
  scopes: [ApiKeyScope.EMBED_CHAT],
  status: 'active',
  keyPrefix: 'b4m_live_abc123',
  agentId: 'agent-1',
  allowedOrigins: ['https://example.com'],
  branding: { displayName: 'Acme', hideBranding: true },
  createdAt: new Date('2026-01-01'),
};
const plainKey = {
  id: 'key-2',
  name: 'CLI key',
  scopes: [ApiKeyScope.AI_CHAT],
  status: 'active',
  keyPrefix: 'b4m_live_z',
};

const h = vi.hoisted(() => ({ keys: [] as any[], updateMutate: vi.fn() }));

vi.mock('@client/app/hooks/data/userApiKeys', () => ({
  useGetUserApiKeys: () => ({ data: h.keys, isLoading: false, error: null, refetch: vi.fn() }),
  useCreateUserApiKey: () => ({ mutate: vi.fn(), isPending: false }),
  useRotateUserApiKey: () => ({ mutate: vi.fn(), isPending: false }),
  useRevokeUserApiKey: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateEmbedKey: () => ({ mutate: h.updateMutate, isPending: false }),
}));

vi.mock('@client/app/hooks/data/agents', () => ({
  useGetAgents: () => ({
    data: [
      { id: 'agent-1', name: 'Agent One' },
      { id: 'agent-2', name: 'Agent Two' },
    ],
    isLoading: false,
  }),
}));

vi.mock('@client/app/hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({ copied: false, handleCopyToClipboard: vi.fn() }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <EmbedKeysTab />
    </CssVarsProvider>
  );

describe('EmbedKeysTab', () => {
  beforeEach(() => {
    h.keys = [embedKey, plainKey];
    h.updateMutate.mockClear();
  });

  it('lists embed:chat keys and filters out non-embed keys', () => {
    renderTab();
    expect(screen.getByTestId('embed-key-row-key-1')).toBeInTheDocument();
    expect(screen.queryByTestId('embed-key-row-key-2')).not.toBeInTheDocument();
  });

  it('does not call update on a no-op Configure-save (cannot clobber hideBranding)', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('embed-key-configure-key-1'));
    fireEvent.click(screen.getByTestId('embed-key-save-btn'));
    expect(h.updateMutate).not.toHaveBeenCalled();
  });

  it('sends only the changed field when origins are edited, leaving branding untouched', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('embed-key-configure-key-1'));

    fireEvent.change(screen.getByTestId('embed-key-origin-input'), { target: { value: 'acme.com' } });
    fireEvent.click(screen.getByTestId('embed-key-origin-add'));
    fireEvent.click(screen.getByTestId('embed-key-save-btn'));

    expect(h.updateMutate).toHaveBeenCalledTimes(1);
    const arg = h.updateMutate.mock.calls[0][0];
    expect(arg).toEqual({ keyId: 'key-1', allowedOrigins: ['https://example.com', 'https://acme.com'] });
    // branding + agentId were untouched, so they must not be in the partial update.
    expect('branding' in arg).toBe(false);
    expect('agentId' in arg).toBe(false);
  });

  // The list route now returns disabled keys (#776); before that this row could
  // never render and the Revoked branch was dead code.
  it('renders a revoked key as Revoked with its actions disabled', () => {
    h.keys = [{ ...embedKey, id: 'key-3', status: 'disabled' }];
    renderTab();

    const row = screen.getByTestId('embed-key-row-key-3');
    expect(row).toHaveTextContent('Revoked');
    expect(screen.getByTestId('embed-key-configure-key-3')).toBeDisabled();
    expect(screen.getByTestId('embed-key-revoke-key-3')).toBeDisabled();
  });
});
