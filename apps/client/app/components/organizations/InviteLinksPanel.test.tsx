import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { OrgInviteLink } from '@client/app/hooks/data/organizations';
import InviteLinksPanel, { parseDomains } from './InviteLinksPanel';

const mocks = vi.hoisted(() => ({
  links: [] as OrgInviteLink[],
  create: vi.fn(),
  revoke: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@client/app/hooks/data/organizations', () => ({
  useOrganizationInviteLinks: () => ({ data: mocks.links }),
  useCreateOrganizationInviteLink: () => ({ mutate: mocks.create, isPending: false }),
  useRevokeOrganizationInviteLink: () => ({ mutate: mocks.revoke, isPending: false }),
}));
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

const renderPanel = () =>
  render(<InviteLinksPanel organizationId="org1" canGrantAdmin={false} />, { wrapper: TestWrapper });

describe('InviteLinksPanel', () => {
  beforeEach(() => {
    mocks.links = [];
    mocks.create.mockReset();
    mocks.revoke.mockReset();
    mocks.toastSuccess.mockReset();
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

  it('revokes only after confirmation', () => {
    mocks.links = [link()];
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderPanel();

    fireEvent.click(screen.getByTestId('org-invite-link-revoke-l1'));
    expect(mocks.revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('org-invite-link-revoke-l1'));
    expect(mocks.revoke).toHaveBeenCalledWith('l1');
    confirm.mockRestore();
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

  it('blocks create on a non-positive cap', () => {
    renderPanel();
    fireEvent.change(screen.getByTestId('org-invite-link-cap-input'), { target: { value: '0' } });
    expect(screen.getByTestId('org-invite-link-create-btn')).toHaveProperty('disabled', true);
  });

  it('parseDomains drops blanks and duplicates', () => {
    expect(parseDomains('  a.com ,, A.com;b.org ')).toEqual(['a.com', 'b.org']);
  });
});
