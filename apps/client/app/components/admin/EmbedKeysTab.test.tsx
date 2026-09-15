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

const h = vi.hoisted(() => ({
  keys: [] as any[],
  updateMutate: vi.fn(),
  createMutate: vi.fn(),
  billingOrgs: [] as { id: string; name: string }[],
  allOrgs: [] as { id: string; name: string }[],
  isAdmin: false,
}));

vi.mock('@client/app/hooks/data/userApiKeys', () => ({
  useGetUserApiKeys: () => ({ data: h.keys, isLoading: false, error: null, refetch: vi.fn() }),
  useCreateUserApiKey: () => ({ mutate: h.createMutate, isPending: false }),
  useRotateUserApiKey: () => ({ mutate: vi.fn(), isPending: false }),
  useRevokeUserApiKey: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateEmbedKey: () => ({ mutate: h.updateMutate, isPending: false }),
  useBillingOrganizations: () => ({ data: h.billingOrgs, isLoading: false }),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'u1', isAdmin: h.isAdmin } }),
}));

// The admin branch searches ALL orgs (useSearchOrganizations, no userId filter);
// return a fixed set regardless of the search term so the Autocomplete has options.
vi.mock('@client/app/hooks/data/organizations', () => ({
  useSearchOrganizations: () => ({
    data: { data: h.allOrgs, totalPages: 1, totalOrganizations: h.allOrgs.length },
    isLoading: false,
  }),
  // Label-resolver fallback for a set-but-off-page org; the admin picker only needs
  // it on the cold-start/role-flip path, so null is fine for these tests.
  useGetOrganization: () => ({ data: null }),
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
    h.billingOrgs = [{ id: 'org-1', name: 'Acme Org' }];
    h.allOrgs = [{ id: 'org-admin', name: 'Global Org' }];
    h.isAdmin = false;
    h.updateMutate.mockClear();
    h.createMutate.mockClear();
    ent.data = [];
  });

  const fillNameAndAgent = (name: string) => {
    fireEvent.change(within(screen.getByTestId('embed-key-name-input')).getByRole('textbox'), {
      target: { value: name },
    });
    fireEvent.click(within(screen.getByTestId('embed-key-agent-select')).getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'Agent One' }));
  };

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

    // Org is required, so pick one to isolate what this test asserts: the model
    // warning is advisory and does not, by itself, block submit.
    fireEvent.click(within(screen.getByTestId('embed-key-org-select')).getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'Acme Org' }));

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

  // Embed keys must be org-owned, so the create payload has to carry organizationId -
  // its absence is exactly the #876 bug (keys defaulted to user-owned and got rejected).
  it('sends the chosen organizationId in the create payload (non-admin)', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('embed-key-new-btn'));
    fillNameAndAgent('Marketing site');

    fireEvent.click(within(screen.getByTestId('embed-key-org-select')).getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'Acme Org' }));

    fireEvent.click(screen.getByTestId('embed-key-create-btn'));

    expect(h.createMutate).toHaveBeenCalledTimes(1);
    expect(h.createMutate.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        name: 'Marketing site',
        scopes: [ApiKeyScope.EMBED_CHAT],
        agentId: 'agent-1',
        organizationId: 'org-1',
      })
    );
  });

  it('resets the create form on cancel so a filled-then-cancelled form does not reappear', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('embed-key-new-btn'));
    fillNameAndAgent('Marketing site');
    fireEvent.click(within(screen.getByTestId('embed-key-org-select')).getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'Acme Org' }));
    // Cancel, then reopen.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByTestId('embed-key-new-btn'));

    expect(within(screen.getByTestId('embed-key-name-input')).getByRole('textbox')).toHaveValue('');
    expect(screen.getByTestId('embed-key-create-btn')).toBeDisabled();
  });

  it('keeps Create disabled until an organization is chosen', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('embed-key-new-btn'));
    fillNameAndAgent('Marketing site');
    expect(screen.getByTestId('embed-key-create-btn')).toBeDisabled();

    fireEvent.click(within(screen.getByTestId('embed-key-org-select')).getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'Acme Org' }));
    expect(screen.getByTestId('embed-key-create-btn')).not.toBeDisabled();
  });

  it('tells a non-admin who administers no org they cannot mint, and blocks Create', () => {
    h.billingOrgs = [];
    renderTab();
    fireEvent.click(screen.getByTestId('embed-key-new-btn'));
    expect(screen.getByTestId('embed-key-org-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('embed-key-org-select')).not.toBeInTheDocument();
    expect(screen.getByTestId('embed-key-create-btn')).toBeDisabled();
  });

  // A platform admin picks from ALL orgs (not the billing-organizations set), so
  // they can mint for any tenant - the create route's isAdmin bypass allows it.
  it('lets a platform admin pick any org, flowing organizationId into the create payload', async () => {
    h.isAdmin = true;
    renderTab();
    fireEvent.click(screen.getByTestId('embed-key-new-btn'));
    fillNameAndAgent('Marketing site');
    // The non-admin Select is not used for admins.
    expect(screen.queryByTestId('embed-key-org-select')).not.toBeInTheDocument();

    const combo = within(screen.getByTestId('embed-key-org-admin-select')).getByRole('combobox');
    fireEvent.change(combo, { target: { value: 'Global' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Global Org' }));

    fireEvent.click(screen.getByTestId('embed-key-create-btn'));

    expect(h.createMutate).toHaveBeenCalledTimes(1);
    expect(h.createMutate.mock.calls[0][0]).toEqual(expect.objectContaining({ organizationId: 'org-admin' }));
  });

  // Ownership is fixed at creation; Configure's PATCH never changes it, so the org
  // picker must not appear there (nor drag in the shared form fields).
  it('does not show an org picker in the Configure modal', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('embed-key-configure-key-1'));
    expect(screen.queryByTestId('embed-key-org-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('embed-key-org-admin-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('embed-key-org-empty')).not.toBeInTheDocument();
  });

  it('marks rows bound to a model-less agent with a warning indicator', () => {
    renderTab();
    expect(screen.getByTestId('embed-key-row-model-warning-key-4')).toBeInTheDocument();
  });

  it('shows no row indicator for a key bound to an agent with an explicit model', () => {
    renderTab();
    expect(screen.queryByTestId('embed-key-row-model-warning-key-1')).not.toBeInTheDocument();
  });

  it('shows no row indicator when the bound agent is not in the fetched list', () => {
    h.keys = [{ ...modellessAgentKey, id: 'key-8', agentId: 'agent-ghost' }];
    renderTab();
    expect(screen.getByTestId('embed-key-row-key-8')).toBeInTheDocument();
    expect(screen.queryByTestId('embed-key-row-model-warning-key-8')).not.toBeInTheDocument();
  });
});
