import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IGrantPackageDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { GrantPackageFormModal } from './GrantPackageFormModal';

const api = vi.hoisted(() => ({
  createGrantPackage: vi.fn(),
  updateGrantPackage: vi.fn(),
  fetchGrantPackageLinks: vi.fn(),
  createRegInvites: vi.fn(),
  updateRegInvite: vi.fn(),
  createPartnerSignupRule: vi.fn(),
  updatePartnerSignupRule: vi.fn(),
  searchOrganizations: vi.fn(),
  fetchOrganizationById: vi.fn(),
}));
vi.mock('@client/app/utils/grantPackageAPICalls', () => ({
  createGrantPackage: api.createGrantPackage,
  updateGrantPackage: api.updateGrantPackage,
  fetchGrantPackageLinks: api.fetchGrantPackageLinks,
  grantPackageLinksQueryKey: (id: string) => ['admin-grant-packages', id, 'links'],
  GRANT_PACKAGES_QUERY_KEY: 'admin-grant-packages',
}));
vi.mock('@client/app/utils/regInviteAPICalls', () => ({
  createRegInvites: api.createRegInvites,
  updateRegInvite: api.updateRegInvite,
}));
vi.mock('@client/app/utils/partnerSignupRuleAPICalls', () => ({
  createPartnerSignupRule: api.createPartnerSignupRule,
  updatePartnerSignupRule: api.updatePartnerSignupRule,
  searchOrganizations: api.searchOrganizations,
  fetchOrganizationById: api.fetchOrganizationById,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const user = vi.hoisted(() => ({ current: { id: 'admin-1', isAdmin: true } as { id: string; isAdmin: boolean } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: user.current }) }));

const appTheme = extendTheme({ ...getThemeConfig() });
const policy = { singleGrantCredits: 50_000, dailyTotalCredits: 200_000 };
const pkg = {
  id: 'p1',
  name: 'Launch',
  credits: 100,
  totalCap: 10,
  dailyCap: null,
  redeemedTotal: 0,
  capHits: 0,
  active: true,
  createdBy: 'admin-1',
} as unknown as IGrantPackageDocument;
const links = (invites: unknown[] = [], partnerRules: unknown[] = [], rulesTruncated = false) => ({
  invites: { data: invites, truncated: false },
  partnerRules: { data: partnerRules, truncated: rulesTruncated },
});

const renderModal = (editing: IGrantPackageDocument | null) => {
  const props = { onClose: vi.fn(), onSaved: vi.fn() };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <GrantPackageFormModal open editing={editing} reasonPolicy={policy} {...props} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return props;
};
const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('GrantPackageFormModal invite codes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchGrantPackageLinks.mockResolvedValue(links());
    api.createGrantPackage.mockResolvedValue({ ...pkg, id: 'p2', name: 'Fresh' });
    api.updateGrantPackage.mockResolvedValue(pkg);
    api.createRegInvites.mockResolvedValue([{ code: 'NEW1' }]);
  });

  it('lists the codes linked to the package being edited', async () => {
    api.fetchGrantPackageLinks.mockResolvedValue(
      links([
        { id: 'i1', code: 'ALPHA', unlimitedUse: false },
        { id: 'i2', code: 'BETA', unlimitedUse: false, used: new Date('2026-01-01') },
      ])
    );
    renderModal(pkg);
    expect(await screen.findByTestId('grant-package-code-row-ALPHA')).toHaveTextContent('Active');
    expect(screen.getByTestId('grant-package-code-row-BETA')).toHaveTextContent('Inactive');
    expect(api.fetchGrantPackageLinks).toHaveBeenCalledWith('p1');
  });

  it('adds a code to the edited package straight away', async () => {
    renderModal(pkg);
    await screen.findByTestId('grant-package-codes-empty');
    fireEvent.click(screen.getByTestId('grant-package-code-unlimited-switch'));
    fireEvent.click(screen.getByTestId('grant-package-add-code-btn'));
    await waitFor(() =>
      expect(api.createRegInvites).toHaveBeenCalledWith({ multiple: 1, unlimitedUse: true, grantPackageId: 'p1' })
    );
    expect(api.updateGrantPackage).not.toHaveBeenCalled();
  });

  it('shows a failed add inline and keeps the form open', async () => {
    api.createRegInvites.mockRejectedValue(new Error('Grant package has expired'));
    const props = renderModal(pkg);
    await screen.findByTestId('grant-package-codes-empty');
    fireEvent.click(screen.getByTestId('grant-package-add-code-btn'));
    expect(await screen.findByTestId('grant-package-codes-error')).toHaveTextContent('Grant package has expired');
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', { expiresAt: new Date('2020-01-01') }, 'expired'],
    ['inactive', { active: false }, 'inactive'],
  ])('disables adding codes to an %s package', async (_label, patch, copy) => {
    renderModal({ ...pkg, ...patch } as IGrantPackageDocument);
    expect(screen.getByTestId('grant-package-add-code-btn')).toBeDisabled();
    expect(screen.getByTestId('grant-package-codes-closed')).toHaveTextContent(copy);
  });

  it('creates the package first, then each queued code against it, then closes', async () => {
    const props = renderModal(null);
    type('grant-package-name-input', 'Fresh');
    type('grant-package-credits-input', '100');
    type('grant-package-total-cap-input', '10');
    fireEvent.click(screen.getByTestId('grant-package-add-code-btn'));
    fireEvent.click(screen.getByTestId('grant-package-code-unlimited-switch'));
    fireEvent.click(screen.getByTestId('grant-package-add-code-btn'));
    expect(api.createRegInvites).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('grant-package-save-btn'));

    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(api.createGrantPackage).toHaveBeenCalledTimes(1);
    expect(api.createRegInvites.mock.calls).toEqual([
      [{ multiple: 1, unlimitedUse: false, grantPackageId: 'p2' }],
      [{ multiple: 1, unlimitedUse: true, grantPackageId: 'p2' }],
    ]);
    expect(api.createGrantPackage.mock.invocationCallOrder[0]).toBeLessThan(
      api.createRegInvites.mock.invocationCallOrder[0]
    );
  });

  it('on a code failure keeps the form open on the saved package and says what was not created', async () => {
    api.createRegInvites.mockResolvedValueOnce([{ code: 'OK1' }]).mockRejectedValueOnce(new Error('boom'));
    const props = renderModal(null);
    type('grant-package-name-input', 'Fresh');
    type('grant-package-credits-input', '100');
    type('grant-package-total-cap-input', '10');
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByTestId('grant-package-add-code-btn'));
    fireEvent.click(screen.getByTestId('grant-package-save-btn'));

    expect(await screen.findByTestId('grant-package-form-error')).toHaveTextContent(
      'Created Fresh, but 2 of 3 codes were not created: boom'
    );
    expect(api.createRegInvites).toHaveBeenCalledTimes(2);
    expect(props.onSaved).toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('grant-package-save-btn')).toHaveTextContent('Save package');
    await waitFor(() => expect(api.fetchGrantPackageLinks).toHaveBeenCalledWith('p2'));

    fireEvent.click(screen.getByTestId('grant-package-save-btn'));
    await waitFor(() => expect(api.updateGrantPackage).toHaveBeenCalledWith('p2', expect.anything()));
    expect(api.createGrantPackage).toHaveBeenCalledTimes(1);
  });
});

describe('GrantPackageFormModal inline code edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchGrantPackageLinks.mockResolvedValue(
      links([{ id: 'i1', code: 'ALPHA', unlimitedUse: false, expiresAt: '2030-01-31T23:59:59.999Z' }])
    );
    api.updateRegInvite.mockResolvedValue([{ id: 'i1' }]);
  });

  it('prefills the code, saves unlimited use and a new expiry day, then closes the editor and refetches', async () => {
    const props = renderModal(pkg);
    fireEvent.click(await screen.findByTestId('grant-package-code-edit-btn-ALPHA'));
    expect(screen.getByTestId('grant-package-code-edit')).toHaveTextContent('Edit code ALPHA');
    expect(screen.getByTestId('grant-package-code-edit-expires-input')).toHaveValue('2030-01-31');

    fireEvent.click(screen.getByTestId('grant-package-code-edit-unlimited-switch'));
    type('grant-package-code-edit-expires-input', '2031-06-15');
    expect(screen.getByTestId('grant-package-code-edit-save-btn')).toBeDisabled();
    type('grant-package-code-edit-reason', 'Extending the partner pilot for another year');
    fireEvent.click(screen.getByTestId('grant-package-code-edit-save-btn'));

    await waitFor(() =>
      expect(api.updateRegInvite).toHaveBeenCalledWith('i1', {
        unlimitedUse: true,
        expiresAt: new Date('2031-06-15T23:59:59.999Z'),
        reason: 'Extending the partner pilot for another year',
      })
    );
    await waitFor(() => expect(screen.queryByTestId('grant-package-code-edit')).not.toBeInTheDocument());
    await waitFor(() => expect(api.fetchGrantPackageLinks).toHaveBeenCalledTimes(2));
    expect(api.updateGrantPackage).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('clears the expiry when the day is emptied', async () => {
    renderModal(pkg);
    fireEvent.click(await screen.findByTestId('grant-package-code-edit-btn-ALPHA'));
    type('grant-package-code-edit-expires-input', '');
    type('grant-package-code-edit-reason', 'Partner asked for an open-ended code');
    fireEvent.click(screen.getByTestId('grant-package-code-edit-save-btn'));
    await waitFor(() =>
      expect(api.updateRegInvite).toHaveBeenCalledWith('i1', {
        unlimitedUse: false,
        expiresAt: null,
        reason: 'Partner asked for an open-ended code',
      })
    );
  });

  it('asks for no reason when the edit shortens the expiry', async () => {
    renderModal(pkg);
    fireEvent.click(await screen.findByTestId('grant-package-code-edit-btn-ALPHA'));
    type('grant-package-code-edit-expires-input', '2029-12-31');
    expect(screen.queryByTestId('grant-package-code-edit-reason')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('grant-package-code-edit-save-btn'));
    await waitFor(() =>
      expect(api.updateRegInvite).toHaveBeenCalledWith('i1', {
        unlimitedUse: false,
        expiresAt: new Date('2029-12-31T23:59:59.999Z'),
      })
    );
  });

  it('keeps the editor open and shows the error when the save fails', async () => {
    api.updateRegInvite.mockRejectedValue(new Error('Invalid invite id'));
    renderModal(pkg);
    fireEvent.click(await screen.findByTestId('grant-package-code-edit-btn-ALPHA'));
    fireEvent.click(screen.getByTestId('grant-package-code-edit-save-btn'));
    expect(await screen.findByTestId('grant-package-codes-error')).toHaveTextContent('Invalid invite id');
    expect(screen.getByTestId('grant-package-code-edit')).toBeInTheDocument();
  });

  it('discards the edit on cancel without saving', async () => {
    renderModal(pkg);
    fireEvent.click(await screen.findByTestId('grant-package-code-edit-btn-ALPHA'));
    fireEvent.click(screen.getByTestId('grant-package-code-edit-cancel-btn'));
    expect(screen.queryByTestId('grant-package-code-edit')).not.toBeInTheDocument();
    expect(api.updateRegInvite).not.toHaveBeenCalled();
  });

  it('keeps a mid-day expiry and asks for no reason when only unlimited use is turned off', async () => {
    api.fetchGrantPackageLinks.mockResolvedValue(
      links([{ id: 'i2', code: 'BRAVO', unlimitedUse: true, expiresAt: '2030-03-10T08:15:00.000Z' }])
    );
    renderModal(pkg);
    fireEvent.click(await screen.findByTestId('grant-package-code-edit-btn-BRAVO'));
    fireEvent.click(screen.getByTestId('grant-package-code-edit-unlimited-switch'));
    expect(screen.queryByTestId('grant-package-code-edit-reason')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('grant-package-code-edit-save-btn'));
    await waitFor(() => expect(api.updateRegInvite).toHaveBeenCalledWith('i2', { unlimitedUse: false }));
  });
});

describe('GrantPackageFormModal expiry on edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchGrantPackageLinks.mockResolvedValue(links());
    api.updateGrantPackage.mockResolvedValue(pkg);
  });

  it('leaves a mid-day expiry untouched when only the name changes', async () => {
    renderModal({ ...pkg, expiresAt: '2030-03-10T12:00:00.000Z' } as unknown as IGrantPackageDocument);
    type('grant-package-name-input', 'Renamed');
    fireEvent.click(screen.getByTestId('grant-package-save-btn'));
    await waitFor(() => expect(api.updateGrantPackage).toHaveBeenCalled());
    const body = api.updateGrantPackage.mock.calls[0][1];
    expect(body.name).toBe('Renamed');
    expect(body).not.toHaveProperty('expiresAt');
  });

  it('keeps a package that expired earlier today expired after an edit', async () => {
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    renderModal({ ...pkg, expiresAt } as unknown as IGrantPackageDocument);
    type('grant-package-name-input', 'Renamed');
    fireEvent.click(screen.getByTestId('grant-package-save-btn'));
    await waitFor(() => expect(api.updateGrantPackage).toHaveBeenCalled());
    expect(api.updateGrantPackage.mock.calls[0][1]).not.toHaveProperty('expiresAt');
  });

  it('sends the end of a newly picked day', async () => {
    renderModal({ ...pkg, expiresAt: '2030-03-10T12:00:00.000Z' } as unknown as IGrantPackageDocument);
    type('grant-package-expires-input', '2030-04-01');
    fireEvent.click(screen.getByTestId('grant-package-save-btn'));
    await waitFor(() =>
      expect(api.updateGrantPackage).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ expiresAt: new Date('2030-04-01T23:59:59.999Z') })
      )
    );
  });
});

describe('GrantPackageFormModal codes for a delegated admin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    user.current = { id: 'delegate-1', isAdmin: false };
    api.fetchGrantPackageLinks.mockResolvedValue(links());
  });
  afterEach(() => {
    user.current = { id: 'admin-1', isAdmin: true };
  });

  it('explains codes are admin-only and offers no code controls or code fetch', async () => {
    renderModal(pkg);
    expect(screen.getByTestId('grant-package-codes-admin-only')).toBeInTheDocument();
    expect(screen.getByTestId('grant-package-domains-admin-only')).toBeInTheDocument();
    expect(screen.queryByTestId('grant-package-add-domain-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('grant-package-add-code-btn')).not.toBeInTheDocument();
    expect(api.fetchGrantPackageLinks).not.toHaveBeenCalled();
  });
});

const ACME = { id: 'org1', name: 'Acme' };
const rule = (domain: string, extra: Record<string, unknown> = {}) => ({
  id: `r-${domain}`,
  domain,
  enabled: true,
  organizationId: null,
  ...extra,
});
const fillNewPackage = () => {
  type('grant-package-name-input', 'Fresh');
  type('grant-package-credits-input', '100');
  type('grant-package-total-cap-input', '10');
};
const inputIn = (testId: string) => screen.getByTestId(testId).querySelector('input') as HTMLInputElement;
const typeDomain = (domain: string) =>
  fireEvent.change(inputIn('partner-rule-domain-input'), { target: { value: domain } });
const pickAcme = async () => {
  await userEvent.type(inputIn('partner-rule-org-input'), 'Ac');
  await userEvent.click(await screen.findByRole('option', { name: 'Acme' }));
};

describe('GrantPackageFormModal partner domains', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchGrantPackageLinks.mockResolvedValue(links());
    api.createGrantPackage.mockResolvedValue({ ...pkg, id: 'p2', name: 'Fresh' });
    api.updateGrantPackage.mockResolvedValue(pkg);
    api.createRegInvites.mockResolvedValue([{ code: 'NEW1' }]);
    api.createPartnerSignupRule.mockResolvedValue(rule('new.com'));
    api.updatePartnerSignupRule.mockResolvedValue(rule('partner.com'));
    api.searchOrganizations.mockResolvedValue([ACME]);
    api.fetchOrganizationById.mockResolvedValue(ACME);
  });

  it('lists the linked domains with their state and organization', async () => {
    api.fetchOrganizationById.mockImplementation(async (id: string) => (id === 'org1' ? ACME : null));
    api.fetchGrantPackageLinks.mockResolvedValue(
      links(
        [],
        [
          rule('partner.com', { organizationId: 'org1' }),
          rule('gone.com', { organizationId: 'org-gone', enabled: false }),
          rule('solo.com'),
        ],
        true
      )
    );
    renderModal(pkg);

    await waitFor(() => expect(screen.getByTestId('grant-package-domain-row-partner.com')).toHaveTextContent('Acme'));
    expect(screen.getByTestId('grant-package-domain-row-partner.com')).toHaveTextContent('Enabled');
    await waitFor(() => expect(screen.getByTestId('grant-package-domain-row-gone.com')).toHaveTextContent('org-gone'));
    expect(screen.getByTestId('grant-package-domain-row-gone.com')).toHaveTextContent('Disabled');
    expect(screen.getByTestId('grant-package-domain-row-solo.com')).toHaveTextContent('No organization');
    expect(screen.getByTestId('grant-package-domains-truncated')).toHaveTextContent('newest 3 domains');
  });

  it('says when no domain uses the package', async () => {
    renderModal(pkg);
    expect(await screen.findByTestId('grant-package-domains-empty')).toBeInTheDocument();
  });

  it('shows a failed links load', async () => {
    api.fetchGrantPackageLinks.mockRejectedValue(new Error('links down'));
    renderModal(pkg);
    expect(await screen.findByTestId('grant-package-domains-load-error')).toHaveTextContent('links down');
  });

  it('adds a domain to the edited package straight away, linked to it', async () => {
    renderModal(pkg);
    await screen.findByTestId('grant-package-domains-empty');
    fireEvent.click(screen.getByTestId('grant-package-add-domain-btn'));
    expect(screen.getByTestId('grant-package-domain-add-save-btn')).toBeDisabled();
    typeDomain(' new.com ');
    await pickAcme();
    fireEvent.click(inputIn('partner-rule-enabled-switch'));
    fireEvent.click(screen.getByTestId('grant-package-domain-add-save-btn'));

    await waitFor(() =>
      expect(api.createPartnerSignupRule).toHaveBeenCalledWith({
        domain: 'new.com',
        entitlements: [],
        signupCredits: 0,
        enabled: false,
        organizationId: 'org1',
        grantPackageId: 'p1',
      })
    );
    await waitFor(() => expect(screen.queryByTestId('grant-package-domain-add')).not.toBeInTheDocument());
    await waitFor(() => expect(api.fetchGrantPackageLinks).toHaveBeenCalledTimes(2));
    expect(api.updateGrantPackage).not.toHaveBeenCalled();
  });

  it('shows a domain already ruled elsewhere inline and keeps the editor open until cancelled', async () => {
    api.createPartnerSignupRule.mockRejectedValue(new Error('A signup rule for "taken.com" already exists'));
    renderModal(pkg);
    await screen.findByTestId('grant-package-domains-empty');
    fireEvent.click(screen.getByTestId('grant-package-add-domain-btn'));
    typeDomain('taken.com');
    fireEvent.click(screen.getByTestId('grant-package-domain-add-save-btn'));

    expect(await screen.findByTestId('grant-package-domains-error')).toHaveTextContent('already exists');
    expect(screen.getByTestId('grant-package-domain-add')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('grant-package-domain-add-cancel-btn'));
    expect(screen.queryByTestId('grant-package-domain-add')).not.toBeInTheDocument();
  });

  it.each([
    ['expired', { expiresAt: new Date('2020-01-01') }, 'expired'],
    ['inactive', { active: false }, 'inactive'],
  ])('disables adding domains to an %s package', async (_label, patch, copy) => {
    renderModal({ ...pkg, ...patch } as IGrantPackageDocument);
    expect(screen.getByTestId('grant-package-add-domain-btn')).toBeDisabled();
    expect(screen.getByTestId('grant-package-domains-closed')).toHaveTextContent(copy);
  });

  it('edits a linked domain, seeding its organization, and saves state and org', async () => {
    api.fetchGrantPackageLinks.mockResolvedValue(links([], [rule('partner.com', { organizationId: 'org1' })]));
    renderModal(pkg);
    fireEvent.click(await screen.findByTestId('grant-package-domain-edit-btn-partner.com'));

    expect(inputIn('partner-rule-domain-input')).toBeDisabled();
    await waitFor(() => expect(inputIn('partner-rule-org-input')).toHaveValue('Acme'));
    fireEvent.click(inputIn('partner-rule-enabled-switch'));
    fireEvent.click(screen.getByTestId('grant-package-domain-edit-save-btn'));

    await waitFor(() =>
      expect(api.updatePartnerSignupRule).toHaveBeenCalledWith('r-partner.com', {
        enabled: false,
        organizationId: 'org1',
      })
    );
    await waitFor(() => expect(screen.queryByTestId('grant-package-domain-edit')).not.toBeInTheDocument());
  });

  it('unlinks a domain from the package and shows a failed edit inline', async () => {
    api.fetchGrantPackageLinks.mockResolvedValue(links([], [rule('solo.com', { organizationId: undefined })]));
    api.updatePartnerSignupRule.mockRejectedValueOnce(new Error('Rule not found'));
    renderModal(pkg);
    fireEvent.click(await screen.findByTestId('grant-package-domain-edit-btn-solo.com'));

    fireEvent.click(screen.getByTestId('grant-package-domain-edit-save-btn'));
    expect(await screen.findByTestId('grant-package-domains-error')).toHaveTextContent('Rule not found');
    expect(api.updatePartnerSignupRule).toHaveBeenLastCalledWith('r-solo.com', { enabled: true, organizationId: null });

    fireEvent.click(screen.getByTestId('grant-package-domain-unlink-btn'));
    await waitFor(() =>
      expect(api.updatePartnerSignupRule).toHaveBeenLastCalledWith('r-solo.com', { grantPackageId: null })
    );
    await waitFor(() => expect(screen.queryByTestId('grant-package-domains-error')).not.toBeInTheDocument());
    expect(api.fetchOrganizationById).not.toHaveBeenCalled();
  });

  it('discards a domain edit on cancel', async () => {
    api.fetchGrantPackageLinks.mockResolvedValue(links([], [rule('solo.com')]));
    renderModal(pkg);
    fireEvent.click(await screen.findByTestId('grant-package-domain-edit-btn-solo.com'));
    fireEvent.click(screen.getByTestId('grant-package-domain-edit-cancel-btn'));
    expect(screen.queryByTestId('grant-package-domain-edit')).not.toBeInTheDocument();
    expect(api.updatePartnerSignupRule).not.toHaveBeenCalled();
  });

  it('queues domains on a new package and creates them against it after the codes', async () => {
    const props = renderModal(null);
    fillNewPackage();
    fireEvent.click(screen.getByTestId('grant-package-add-code-btn'));
    for (const domain of ['keep.com', 'drop.com', 'off.com']) {
      fireEvent.click(screen.getByTestId('grant-package-add-domain-btn'));
      typeDomain(domain);
      if (domain === 'off.com') fireEvent.click(inputIn('partner-rule-enabled-switch'));
      fireEvent.click(screen.getByTestId('grant-package-domain-add-save-btn'));
    }
    const queued = screen.getByTestId('grant-package-domains-queued');
    expect(queued).toHaveTextContent('off.com (disabled)');
    fireEvent.click(screen.getByTestId('grant-package-queued-domain-remove-1'));
    expect(queued).not.toHaveTextContent('drop.com');
    expect(api.createPartnerSignupRule).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('grant-package-save-btn'));
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(
      api.createPartnerSignupRule.mock.calls.map(([input]) => [input.domain, input.enabled, input.grantPackageId])
    ).toEqual([
      ['keep.com', true, 'p2'],
      ['off.com', false, 'p2'],
    ]);
    expect(api.createRegInvites.mock.invocationCallOrder[0]).toBeLessThan(
      api.createPartnerSignupRule.mock.invocationCallOrder[0]
    );
  });

  it.each([
    [
      'a code',
      () => api.createRegInvites.mockRejectedValue(new Error('boom')),
      '1 of 1 codes and 1 of 1 partner domains',
    ],
    [
      'a domain',
      () => api.createPartnerSignupRule.mockRejectedValue(new Error('boom')),
      'but 1 of 1 partner domains were not created',
    ],
  ])(
    'on %s failure names every link left unsent and keeps editing the saved package',
    async (_label, arrange, copy) => {
      arrange();
      const props = renderModal(null);
      fillNewPackage();
      fireEvent.click(screen.getByTestId('grant-package-add-code-btn'));
      fireEvent.click(screen.getByTestId('grant-package-add-domain-btn'));
      typeDomain('partner.com');
      fireEvent.click(screen.getByTestId('grant-package-domain-add-save-btn'));
      fireEvent.click(screen.getByTestId('grant-package-save-btn'));

      expect(await screen.findByTestId('grant-package-form-error')).toHaveTextContent(copy);
      expect(props.onClose).not.toHaveBeenCalled();
      expect(screen.queryByTestId('grant-package-domains-queued')).not.toBeInTheDocument();
      expect(await screen.findByTestId('grant-package-domains-empty')).toBeInTheDocument();
    }
  );
});

describe('GrantPackageFormModal package fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchGrantPackageLinks.mockResolvedValue(links());
  });

  it('sends the daily cap and active state, and shows a failed save', async () => {
    api.updateGrantPackage.mockRejectedValue(new Error('Package name taken'));
    const props = renderModal(pkg);
    type('grant-package-daily-cap-input', '5');
    fireEvent.click(screen.getByTestId('grant-package-active-switch'));
    fireEvent.click(screen.getByTestId('grant-package-save-btn'));

    expect(await screen.findByTestId('grant-package-form-error')).toHaveTextContent('Package name taken');
    expect(api.updateGrantPackage).toHaveBeenCalledWith('p1', expect.objectContaining({ dailyCap: 5, active: false }));
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('keeps a stored daily cap and rejects caps below 1', () => {
    renderModal({ ...pkg, dailyCap: 3 } as IGrantPackageDocument);
    expect(screen.getByTestId('grant-package-daily-cap-input')).toHaveValue('3');
    type('grant-package-total-cap-input', '0');
    expect(screen.getByTestId('grant-package-save-btn')).toBeDisabled();
  });

  it('refuses a new package that already expired', () => {
    renderModal(null);
    fillNewPackage();
    type('grant-package-expires-input', '2020-01-01');
    expect(screen.getByTestId('grant-package-save-btn')).toBeDisabled();
  });

  it('sends the reason for a package over the large-grant threshold', async () => {
    api.createGrantPackage.mockResolvedValue({ ...pkg, id: 'p2', name: 'Big' });
    const props = renderModal(null);
    type('grant-package-name-input', 'Big');
    type('grant-package-credits-input', '60000');
    fireEvent.click(screen.getByTestId('grant-package-reason-preset-0'));
    fireEvent.click(screen.getByTestId('grant-package-save-btn'));

    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(api.createGrantPackage).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.any(String) }));
  });
});
