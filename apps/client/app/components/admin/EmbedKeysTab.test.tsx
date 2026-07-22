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

// Default DENIED: every pre-Phase-D case runs with the hide-branding toggle
// hidden, which is that era's behavior. Individual tests flip the state.
const gate = vi.hoisted(() => ({ state: 'denied' as string, bypass: false }));
vi.mock('@client/app/hooks/useEntitlementGate', () => ({
  useEntitlementGate: () => ({ state: gate.state, bypass: gate.bypass }),
}));

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
    gate.state = 'denied';
    gate.bypass = false;
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

  describe('hide-branding toggle (whitelabel gate, epic #41 Phase D)', () => {
    it('shows and round-trips the toggle when the whitelabel gate is satisfied', () => {
      gate.state = 'satisfied';
      h.keys = [{ ...embedKey, branding: { displayName: 'Acme' } }];
      renderTab();
      fireEvent.click(screen.getByTestId('embed-key-configure-key-1'));

      const toggle = screen.getByTestId('embed-key-branding-hide');
      fireEvent.click(toggle);
      fireEvent.click(screen.getByTestId('embed-key-save-btn'));

      expect(h.updateMutate).toHaveBeenCalledTimes(1);
      expect(h.updateMutate.mock.calls[0][0]).toEqual({
        keyId: 'key-1',
        branding: { displayName: 'Acme', primaryColor: undefined, logoUrl: undefined, hideBranding: true },
      });
    });

    it('hides the toggle and keeps the plan note when the gate is denied', () => {
      renderTab();
      fireEvent.click(screen.getByTestId('embed-key-configure-key-1'));
      expect(screen.queryByTestId('embed-key-branding-hide')).not.toBeInTheDocument();
      expect(screen.getAllByText(/requires the white-label/i).length).toBeGreaterThan(0);
    });

    it('renders neither the toggle nor a spinner while the gate is pending', () => {
      gate.state = 'pending';
      renderTab();
      fireEvent.click(screen.getByTestId('embed-key-configure-key-1'));
      expect(screen.queryByTestId('embed-key-branding-hide')).not.toBeInTheDocument();
      // The modal already renders a progressbar-free form; pending must not add one.
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    it('still cannot clobber a stored hideBranding on a no-op save while denied', () => {
      renderTab();
      fireEvent.click(screen.getByTestId('embed-key-configure-key-1'));
      fireEvent.click(screen.getByTestId('embed-key-save-btn'));
      expect(h.updateMutate).not.toHaveBeenCalled();
    });
  });
});
