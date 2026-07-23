import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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
// Bound to the model-less agent-2: the fixture for the missing-model warning.
const modellessAgentKey = {
  id: 'key-4',
  name: 'Beta widget',
  scopes: [ApiKeyScope.EMBED_CHAT],
  status: 'active',
  keyPrefix: 'b4m_live_def456',
  agentId: 'agent-2',
  allowedOrigins: [],
  createdAt: new Date('2026-01-02'),
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
    // agent-1 has an explicit model; agent-2 is on the system default (no
    // preferredModel field, matching the real /api/agents payload for an unset model).
    data: [
      { id: 'agent-1', name: 'Agent One', preferredModel: 'claude-test' },
      { id: 'agent-2', name: 'Agent Two' },
    ],
    isLoading: false,
  }),
}));

vi.mock('@client/app/hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({ copied: false, handleCopyToClipboard: vi.fn() }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The Create-form toggle gates on the CURRENT USER's own held entitlements with
// NO admin/developer bypass (the prospective owner is the minter) - so this mock
// stands in for /api/entitlements. The Configure-form toggle instead gates on
// the key's server-computed `ownerHasWhitelabel`, set per-fixture below.
// `undefined` models the still-loading query.
const ent = vi.hoisted(() => ({ data: [] as string[] | undefined }));
vi.mock('@client/app/hooks/data/entitlements', () => ({
  useEntitlements: () => ({ data: ent.data }),
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
    h.keys = [embedKey, plainKey, modellessAgentKey];
    h.updateMutate.mockClear();
    ent.data = [];
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

  // Post-#891 the toggle is owner-scoped: Configure reads the key's
  // server-computed `ownerHasWhitelabel`; Create reads the current user's own
  // entitlements (no admin/developer bypass). Neither honors the viewer's admin.
  describe('hide-branding toggle - owner-scoped (#891)', () => {
    it('Configure: shows and round-trips the toggle when the key OWNER holds white-label', () => {
      h.keys = [{ ...embedKey, ownerHasWhitelabel: true, branding: { displayName: 'Acme' } }];
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

    it('Configure: hides the toggle and keeps the plan note when the OWNER is not entitled', () => {
      h.keys = [{ ...embedKey, ownerHasWhitelabel: false }];
      renderTab();
      fireEvent.click(screen.getByTestId('embed-key-configure-key-1'));
      expect(screen.queryByTestId('embed-key-branding-hide')).not.toBeInTheDocument();
      expect(screen.getAllByText(/requires the white-label/i).length).toBeGreaterThan(0);
    });

    // Parity regression: the toggle follows the OWNER's plan even for a viewer who
    // would have bypassed the old viewer-scoped gate (admin/developer). Configure
    // reads only the server flag, so an unentitled owner's key never offers it.
    it('Configure: does not offer the toggle for an unentitled owner regardless of viewer role', () => {
      h.keys = [{ ...embedKey, ownerHasWhitelabel: false }];
      renderTab();
      fireEvent.click(screen.getByTestId('embed-key-configure-key-1'));
      expect(screen.queryByTestId('embed-key-branding-hide')).not.toBeInTheDocument();
    });

    it('Create: shows the toggle when the current user (prospective owner) is entitled', () => {
      ent.data = ['embed:whitelabel'];
      renderTab();
      fireEvent.click(screen.getByTestId('embed-key-new-btn'));
      expect(screen.getByTestId('embed-key-branding-hide')).toBeInTheDocument();
    });

    // The core Symptom-B parity regression: an admin/developer viewer no longer
    // sees the Create toggle just for being staff - /api/entitlements applies no
    // bypass, so an empty held-set (the unentitled case) hides it.
    it('Create: hides the toggle when the current user is not entitled (no admin/developer bypass)', () => {
      ent.data = [];
      renderTab();
      fireEvent.click(screen.getByTestId('embed-key-new-btn'));
      expect(screen.queryByTestId('embed-key-branding-hide')).not.toBeInTheDocument();
      expect(screen.getAllByText(/requires the white-label/i).length).toBeGreaterThan(0);
    });

    it('Create: hides the toggle (and shows no spinner) while entitlements are still loading', () => {
      ent.data = undefined;
      renderTab();
      fireEvent.click(screen.getByTestId('embed-key-new-btn'));
      expect(screen.queryByTestId('embed-key-branding-hide')).not.toBeInTheDocument();
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    it('Configure: still cannot clobber a stored hideBranding on a no-op save for an unentitled owner', () => {
      h.keys = [{ ...embedKey, ownerHasWhitelabel: false }];
      renderTab();
      fireEvent.click(screen.getByTestId('embed-key-configure-key-1'));
      fireEvent.click(screen.getByTestId('embed-key-save-btn'));
      expect(h.updateMutate).not.toHaveBeenCalled();
    });
  });

  // The list route now returns disabled keys (#776); before that this row could
  // never render and the Revoked branch was dead code.
  it('renders a revoked key as Revoked with its actions disabled', () => {
    h.keys = [{ ...embedKey, id: 'key-9', status: 'disabled' }];
    renderTab();

    const row = screen.getByTestId('embed-key-row-key-9');
    expect(row).toHaveTextContent('Revoked');
    expect(screen.getByTestId('embed-key-configure-key-9')).toBeDisabled();
    expect(screen.getByTestId('embed-key-revoke-key-9')).toBeDisabled();
  });

  it('shows no model warning in the create modal until an agent is selected', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('embed-key-new-btn'));
    expect(screen.queryByTestId('embed-key-model-warning')).not.toBeInTheDocument();
  });

  it('warns in the create modal when the selected agent has no explicit model, without blocking submit', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('embed-key-new-btn'));
    // The testid sits on the Joy Input wrapper; the change event needs the native input.
    fireEvent.change(within(screen.getByTestId('embed-key-name-input')).getByRole('textbox'), {
      target: { value: 'Beta site' },
    });

    // The testid sits on the Select wrapper; the trigger is the button inside it.
    fireEvent.click(within(screen.getByTestId('embed-key-agent-select')).getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'Agent Two' }));

    expect(screen.getByTestId('embed-key-model-warning')).toBeInTheDocument();
    // Advisory only: the warning must not disable creation.
    expect(screen.getByTestId('embed-key-create-btn')).not.toBeDisabled();
  });

  it('warns in the configure modal for a key bound to a model-less agent', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('embed-key-configure-key-4'));
    expect(screen.getByTestId('embed-key-model-warning')).toBeInTheDocument();
    expect(screen.getByTestId('embed-key-save-btn')).not.toBeDisabled();
  });

  it('shows no warning in the configure modal when the bound agent has an explicit model', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('embed-key-configure-key-1'));
    expect(screen.queryByTestId('embed-key-model-warning')).not.toBeInTheDocument();
  });
});
