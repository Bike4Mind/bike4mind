import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
  isLoading: false,
  error: null as Error | null,
  refetch: vi.fn(),
  rotateMutate: vi.fn(),
  revokeMutate: vi.fn(),
  rotatePending: false,
  revokePending: false,
  onRotated: undefined as ((result: { key: string }) => void) | undefined,
}));

vi.mock('@client/app/hooks/data/userApiKeys', () => ({
  useGetUserApiKeys: () => ({ data: h.keys, isLoading: h.isLoading, error: h.error, refetch: h.refetch }),
  useCreateUserApiKey: () => ({ mutate: h.createMutate, isPending: false }),
  useRotateUserApiKey: ({ onSuccess }: { onSuccess?: (result: { key: string }) => void } = {}) => {
    h.onRotated = onSuccess;
    return { mutate: h.rotateMutate, isPending: h.rotatePending };
  },
  useRevokeUserApiKey: () => ({ mutate: h.revokeMutate, isPending: h.revokePending }),
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
    h.isLoading = false;
    h.error = null;
    h.updateMutate.mockClear();
    h.createMutate.mockClear();
    h.refetch.mockClear();
    h.rotateMutate.mockReset();
    h.revokeMutate.mockReset();
    h.rotatePending = false;
    h.revokePending = false;
    ent.data = [];
  });

  // Configure, Rotate and Revoke live in each row's "..." menu.
  const openRowMenu = (id: string) => fireEvent.click(screen.getByTestId(`embed-key-row-actions-${id}`));
  const openConfigure = (id: string) => {
    openRowMenu(id);
    fireEvent.click(screen.getByTestId(`embed-key-configure-${id}`));
  };
  const openRevoke = (id: string) => {
    openRowMenu(id);
    fireEvent.click(screen.getByTestId(`embed-key-revoke-${id}`));
    return screen.getByTestId('embed-key-revoke-dialog');
  };
  const revokeConfirm = () => screen.getByTestId('embed-key-revoke-dialog-confirm-btn');
  const typeKeyName = (value: string) =>
    fireEvent.change(screen.getByTestId('embed-key-revoke-dialog-typed-input'), { target: { value } });

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
    openConfigure('key-1');
    fireEvent.click(screen.getByTestId('embed-key-save-btn'));
    expect(h.updateMutate).not.toHaveBeenCalled();
  });

  it('sends only the changed field when origins are edited, leaving branding untouched', () => {
    renderTab();
    openConfigure('key-1');

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
      openConfigure('key-1');

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
      openConfigure('key-1');
      expect(screen.queryByTestId('embed-key-branding-hide')).not.toBeInTheDocument();
      expect(screen.getAllByText(/requires the white-label/i).length).toBeGreaterThan(0);
    });

    // Parity regression: the toggle follows the OWNER's plan even for a viewer who
    // would have bypassed the old viewer-scoped gate (admin/developer). Configure
    // reads only the server flag, so an unentitled owner's key never offers it.
    it('Configure: does not offer the toggle for an unentitled owner regardless of viewer role', () => {
      h.keys = [{ ...embedKey, ownerHasWhitelabel: false }];
      renderTab();
      openConfigure('key-1');
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
      openConfigure('key-1');
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
    expect(screen.getByTestId('embed-key-row-actions-key-9')).toBeDisabled();
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
    openConfigure('key-4');
    expect(screen.getByTestId('embed-key-model-warning')).toBeInTheDocument();
    expect(screen.getByTestId('embed-key-save-btn')).not.toBeDisabled();
  });

  it('shows no warning in the configure modal when the bound agent has an explicit model', () => {
    renderTab();
    openConfigure('key-1');
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
    openConfigure('key-1');
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

  describe('page frame and toolkit', () => {
    it('opens with the Embed keys page header and lists the keys in one DataTable', () => {
      const { container } = renderTab();
      const root = screen.getByTestId('embed-keys-tab');
      const header = screen.getByTestId('admin-page-header');

      expect(root.firstElementChild).toBe(header);
      expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(/^Embed keys$/);
      expect(within(header).getByTestId('embed-key-refresh-btn')).toHaveTextContent('Refresh');
      expect(within(header).getByTestId('embed-key-new-btn')).toHaveTextContent('Create embed key');

      const table = screen.getByTestId('embed-key-table');
      expect(container.querySelectorAll('table')).toHaveLength(1);
      expect(table).toHaveStyle({ minWidth: '56rem' });
      expect(table.closest('[role="region"]')).toHaveStyle({ overflowX: 'auto' });
      expect(within(screen.getByTestId('embed-key-row-key-1')).getByText('Acme widget')).toHaveStyle({
        whiteSpace: 'nowrap',
      });
    });

    it('shows status as a toned chip and the agent and origins as neutral values', () => {
      h.keys = [embedKey, { ...embedKey, id: 'key-9', status: 'disabled' }];
      renderTab();
      expect(screen.getByTestId('embed-key-status-key-1')).toHaveAttribute('data-tone', 'good');
      expect(screen.getByTestId('embed-key-status-key-1')).toHaveTextContent('Active');
      expect(screen.getByTestId('embed-key-status-key-9')).toHaveAttribute('data-tone', 'neutral');
      expect(screen.getByTestId('embed-key-status-key-9')).toHaveTextContent('Revoked');

      const row = screen.getByTestId('embed-key-row-key-1');
      expect(within(row).getByText('Agent One').closest('.MuiChip-root')).toBeNull();
      expect(within(row).getByText('example.com').closest('[data-tone]')).toHaveAttribute('data-tone', 'neutral');
      expect(row.querySelector('.MuiChip-colorPrimary, .MuiChip-colorSuccess, .MuiChip-colorDanger')).toBeNull();
    });

    it('marks a model-less agent with a warn chip', () => {
      renderTab();
      const chip = screen.getByTestId('embed-key-row-model-warning-key-4');
      expect(chip).toHaveAttribute('data-tone', 'warn');
      expect(chip).toHaveTextContent('No model');
    });

    it('asks before revoking in an action dialog, then sends the revoke with the picked reason', async () => {
      renderTab();
      const dialog = openRevoke('key-1');
      expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Revoke embed key');
      expect(dialog).toHaveTextContent('Sites using Acme widget stop working right away.');
      expect(revokeConfirm()).toHaveClass('MuiButton-colorDanger');
      expect(h.revokeMutate).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('embed-key-revoke-dialog-reason-input-preset-0'));
      typeKeyName('Acme widget');
      fireEvent.click(revokeConfirm());
      await waitFor(() => expect(h.revokeMutate).toHaveBeenCalledTimes(1));
      expect(h.revokeMutate.mock.calls[0][0]).toEqual({ keyId: 'key-1', reason: 'Compromised or leaked key' });

      act(() => h.revokeMutate.mock.calls[0][1].onSuccess());
      expect(screen.queryByTestId('embed-key-revoke-dialog')).toBeNull();
    });

    it('sends a preset with a note as the revoke reason', async () => {
      renderTab();
      openRevoke('key-1');
      fireEvent.click(screen.getByTestId('embed-key-revoke-dialog-reason-input-preset-1'));
      fireEvent.change(screen.getByTestId('embed-key-revoke-dialog-reason-input'), {
        target: { value: ' moved to the v2 widget ' },
      });
      typeKeyName('Acme widget');
      fireEvent.click(revokeConfirm());
      await waitFor(() =>
        expect(h.revokeMutate.mock.calls[0]?.[0]).toEqual({
          keyId: 'key-1',
          reason: 'Site no longer embeds the agent: moved to the v2 widget',
        })
      );
    });

    it('keeps Revoke key locked until the admin types the key name', () => {
      renderTab();
      openRevoke('key-1');
      expect(screen.getByTestId('embed-key-revoke-dialog-typed-expected')).toHaveTextContent('Acme widget');
      fireEvent.click(screen.getByTestId('embed-key-revoke-dialog-reason-input-preset-0'));
      expect(revokeConfirm()).toBeDisabled();
      expect(screen.getByTestId('embed-key-revoke-dialog-hint')).toHaveTextContent(
        'Type the key name exactly to confirm.'
      );

      typeKeyName('Acme');
      expect(revokeConfirm()).toBeDisabled();
      typeKeyName('Acme widget');
      expect(revokeConfirm()).toBeEnabled();
    });

    it('cancels a revoke without sending it', () => {
      renderTab();
      openRevoke('key-1');
      fireEvent.click(screen.getByTestId('embed-key-revoke-dialog-cancel-btn'));
      expect(screen.queryByTestId('embed-key-revoke-dialog')).toBeNull();
      expect(h.revokeMutate).not.toHaveBeenCalled();
    });

    it('keeps the revoke dialog open, with Cancel held and the commit loading, while the revoke is in flight', () => {
      h.revokePending = true;
      renderTab();
      const dialog = openRevoke('key-1');
      expect(revokeConfirm()).toHaveClass('MuiButton-loading');
      expect(screen.getByTestId('embed-key-revoke-dialog-cancel-btn')).toBeDisabled();

      fireEvent.keyDown(dialog, { key: 'Escape' });
      fireEvent.click(screen.getByTestId('embed-key-revoke-dialog-close-btn'));
      fireEvent.click(document.querySelector('.MuiModal-backdrop') as HTMLElement);
      expect(screen.getByTestId('embed-key-revoke-dialog')).toBeInTheDocument();
    });

    it('closes the revoke dialog from Esc once nothing is in flight', () => {
      renderTab();
      const dialog = openRevoke('key-1');
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(screen.queryByTestId('embed-key-revoke-dialog')).toBeNull();
    });

    it('keeps the revoke dialog open when the revoke fails', async () => {
      // The hook reports the failure in a toast; the dialog only closes on success.
      h.revokeMutate.mockImplementation((_payload, options?: { onError?: (error: Error) => void }) =>
        options?.onError?.(new Error('revoke failed'))
      );
      renderTab();
      openRevoke('key-1');
      fireEvent.click(screen.getByTestId('embed-key-revoke-dialog-reason-input-preset-0'));
      typeKeyName('Acme widget');
      fireEvent.click(revokeConfirm());
      await waitFor(() => expect(h.revokeMutate).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId('embed-key-revoke-dialog')).toBeInTheDocument();
      await waitFor(() => expect(revokeConfirm()).toBeEnabled());
    });

    it('asks before rotating, with a reason that is not sent, and shows the commit loading while it runs', async () => {
      renderTab();
      openRowMenu('key-1');
      fireEvent.click(screen.getByTestId('embed-key-rotate-key-1'));
      const rotate = screen.getByTestId('embed-key-rotate-dialog');
      expect(within(rotate).getByRole('heading', { level: 2 })).toHaveTextContent('Rotate embed key');
      expect(rotate).toHaveTextContent('Issues a new secret for Acme widget.');
      expect(rotate).toHaveTextContent('Not stored yet');
      expect(h.rotateMutate).not.toHaveBeenCalled();

      const confirm = screen.getByTestId('embed-key-rotate-dialog-confirm-btn');
      expect(confirm).toBeDisabled();
      fireEvent.click(screen.getByTestId('embed-key-rotate-dialog-reason-input-preset-0'));
      fireEvent.click(confirm);
      await waitFor(() => expect(h.rotateMutate).toHaveBeenCalledTimes(1));
      expect(h.rotateMutate.mock.calls[0]).toEqual(['key-1']);
    });

    it('disables Rotate key in the row menu while a rotate is in flight', () => {
      h.rotatePending = true;
      renderTab();
      openRowMenu('key-1');
      expect(screen.getByTestId('embed-key-rotate-key-1')).toHaveAttribute('aria-disabled', 'true');
    });

    it('shows the rotate commit loading and holds Cancel while the rotate is in flight', () => {
      const view = renderTab();
      openRowMenu('key-1');
      fireEvent.click(screen.getByTestId('embed-key-rotate-key-1'));
      h.rotatePending = true;
      view.rerender(
        <CssVarsProvider theme={appTheme}>
          <EmbedKeysTab />
        </CssVarsProvider>
      );
      expect(screen.getByTestId('embed-key-rotate-dialog-confirm-btn')).toHaveClass('MuiButton-loading');
      expect(screen.getByTestId('embed-key-rotate-dialog-cancel-btn')).toBeDisabled();
      fireEvent.click(screen.getByTestId('embed-key-rotate-dialog-close-btn'));
      expect(screen.getByTestId('embed-key-rotate-dialog')).toBeInTheDocument();
    });

    it('rotates from the row menu and shows the new key once, behind a warn banner', async () => {
      renderTab();
      openRowMenu('key-1');
      fireEvent.click(screen.getByTestId('embed-key-rotate-key-1'));
      fireEvent.click(screen.getByTestId('embed-key-rotate-dialog-reason-input-preset-0'));
      fireEvent.click(screen.getByTestId('embed-key-rotate-dialog-confirm-btn'));
      await waitFor(() => expect(h.rotateMutate).toHaveBeenCalledWith('key-1'));

      act(() => h.onRotated?.({ key: 'b4m_live_secret' }));
      expect(screen.queryByTestId('embed-key-rotate-dialog')).toBeNull();
      const dialog = screen.getByTestId('embed-key-created-dialog');
      expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Embed key created');
      expect(within(dialog).getByTestId('embed-key-created-warning')).toHaveClass('MuiAlert-colorWarning');
      expect(within(dialog).getByTestId('embed-key-plaintext')).not.toHaveValue('b4m_live_secret');

      fireEvent.click(within(dialog).getByTestId('embed-key-created-done-btn'));
      expect(screen.queryByTestId('embed-key-created-dialog')).toBeNull();
    });

    it('titles the create and configure dialogs in sentence case', () => {
      renderTab();
      fireEvent.click(screen.getByTestId('embed-key-new-btn'));
      const create = screen.getByTestId('embed-key-create-dialog');
      expect(within(create).getByRole('heading', { level: 2 })).toHaveTextContent('Create embed key');
      fireEvent.click(screen.getByTestId('embed-key-create-cancel-btn'));

      openConfigure('key-1');
      const configure = screen.getByTestId('embed-key-configure-dialog');
      expect(within(configure).getByRole('heading', { level: 2 })).toHaveTextContent('Configure embed key');
    });

    it('shows an empty state with a create action when there are no embed keys', () => {
      h.keys = [plainKey];
      renderTab();
      const empty = screen.getByTestId('admin-empty-state');
      expect(empty).toHaveTextContent('No embed keys yet');
      fireEvent.click(within(empty).getByTestId('embed-key-empty-create-btn'));
      expect(screen.getByTestId('embed-key-create-dialog')).toBeInTheDocument();
    });

    it('shows table skeleton rows while the keys load', () => {
      h.isLoading = true;
      h.keys = [];
      renderTab();
      expect(screen.getAllByTestId('admin-table-skeleton-row').length).toBeGreaterThan(0);
      expect(screen.queryByTestId('admin-empty-state')).toBeNull();
    });

    it('shows an error state that retries the load', () => {
      h.error = new Error('network down');
      h.keys = [];
      renderTab();
      const error = screen.getByTestId('admin-error-state');
      expect(error).toHaveTextContent('Could not load embed keys.');
      fireEvent.click(within(error).getByTestId('admin-error-retry-btn'));
      expect(h.refetch).toHaveBeenCalledTimes(1);
    });
  });

  it('shows no row indicator when the bound agent is not in the fetched list', () => {
    h.keys = [{ ...modellessAgentKey, id: 'key-8', agentId: 'agent-ghost' }];
    renderTab();
    expect(screen.getByTestId('embed-key-row-key-8')).toBeInTheDocument();
    expect(screen.queryByTestId('embed-key-row-model-warning-key-8')).not.toBeInTheDocument();
  });
});
