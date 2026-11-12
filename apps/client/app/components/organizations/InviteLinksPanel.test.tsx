import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { OrgInviteLink } from '@client/app/hooks/data/organizations';
import InviteLinksPanel, { parseDomains } from './InviteLinksPanel';

const mocks = vi.hoisted(() => ({
  links: [] as OrgInviteLink[],
  create: vi.fn(),
  revoke: vi.fn(),
  toastSuccess: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@client/app/hooks/data/organizations', () => ({
  useOrganizationInviteLinks: () => ({ data: mocks.links }),
  useCreateOrganizationInviteLink: () => ({ mutate: mocks.create, isPending: false }),
  useRevokeOrganizationInviteLink: () => ({ mutate: mocks.revoke, isPending: false }),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => mocks.confirm }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const link = (overrides: Partial<OrgInviteLink> = {}): OrgInviteLink => ({
  id: 'l1',
  link: 'https://app.example.com/share/tok-1',
  permissions: ['read'],
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  remaining: 3,
  accepted: 1,
  allowedDomains: [],
  revokedAt: null,
  ...overrides,
});

const renderPanel = (isOwnerTier = false) =>
  render(<InviteLinksPanel organizationId="org1" isOwnerTier={isOwnerTier} />, { wrapper: TestWrapper });

describe('InviteLinksPanel', () => {
  beforeEach(() => {
    mocks.links = [];
    mocks.create.mockReset();
    mocks.revoke.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.confirm.mockReset();
  });

  it('copies the token link of an active row', async () => {
    mocks.links = [link()];
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPanel();

    fireEvent.click(screen.getByTestId('org-invite-link-copy-l1'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://app.example.com/share/tok-1'));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Invite link copied');
  });

  it('offers revoke but no copy on an active row whose URL the server withheld', () => {
    mocks.links = [link({ link: null, permissions: ['read', 'update', 'share'] })];
    renderPanel();

    expect(screen.queryByTestId('org-invite-link-copy-l1')).toBeNull();
    expect(screen.getByTestId('org-invite-link-revoke-l1')).toBeTruthy();
  });

  it('revokes only once the confirmation dialog is accepted', async () => {
    mocks.links = [link()];
    renderPanel();

    fireEvent.click(screen.getByTestId('org-invite-link-revoke-l1'));
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ type: 'danger' }));
    await mocks.confirm.mock.calls[0][0].onOk();
    expect(mocks.revoke).toHaveBeenCalledWith('l1');
  });

  it('offers a non-owner manager only the Viewer role for a link', () => {
    renderPanel(false);
    fireEvent.click(within(screen.getByTestId('org-invite-link-role-select')).getByRole('combobox'));

    expect(screen.getByRole('option', { name: 'Viewer' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Editor' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Admin' })).toBeNull();
  });

  it('offers the owner tier every link role', () => {
    renderPanel(true);
    fireEvent.click(within(screen.getByTestId('org-invite-link-role-select')).getByRole('combobox'));

    expect(screen.getByRole('option', { name: 'Editor' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Admin' })).toBeTruthy();
  });

  it('offers no copy or revoke on a revoked row', () => {
    mocks.links = [link({ revokedAt: new Date().toISOString(), remaining: 0 })];
    renderPanel();

    expect(screen.getByTestId('org-invite-link-row-l1').textContent).toContain('Revoked');
    expect(screen.queryByTestId('org-invite-link-copy-l1')).toBeNull();
    expect(screen.queryByTestId('org-invite-link-revoke-l1')).toBeNull();
  });

  it('creates a viewer link with the cap and normalized domains', () => {
    renderPanel();
    fireEvent.change(screen.getByTestId('org-invite-link-cap-input'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('org-invite-link-domains-input'), {
      target: { value: '@Example.com, example.com sub.example.org' },
    });
    fireEvent.click(screen.getByTestId('org-invite-link-create-btn'));

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: ['read'],
        available: 2,
        allowedDomains: ['example.com', 'sub.example.org'],
      }),
      expect.anything()
    );
  });

  it.each(['0', '1001'])('blocks create on an out-of-range cap of %s', value => {
    renderPanel();
    fireEvent.change(screen.getByTestId('org-invite-link-cap-input'), { target: { value } });
    expect(screen.getByTestId('org-invite-link-create-btn')).toHaveProperty('disabled', true);
  });

  it('allows the largest cap the server accepts', () => {
    renderPanel();
    fireEvent.change(screen.getByTestId('org-invite-link-cap-input'), { target: { value: '1000' } });
    expect(screen.getByTestId('org-invite-link-create-btn')).toHaveProperty('disabled', false);
  });

  it('parseDomains drops blanks and duplicates', () => {
    expect(parseDomains('  a.com ,, A.com;b.org ')).toEqual(['a.com', 'b.org']);
  });
});
