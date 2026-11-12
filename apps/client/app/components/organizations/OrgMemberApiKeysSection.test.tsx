import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { ApiKeyStatus, type IOrgMemberApiKeyView } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import OrgMemberApiKeysSection from './OrgMemberApiKeysSection';

const mutateAsync = vi.fn();
const queryState: { data?: IOrgMemberApiKeyView[]; isLoading: boolean; isError: boolean } = {
  isLoading: false,
  isError: false,
};

vi.mock('@client/app/hooks/data/orgApiKeys', () => ({
  useOrgMemberApiKeys: () => queryState,
  useRevokeOrgMemberApiKey: () => ({ mutateAsync, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const memberKey = (overrides: Partial<IOrgMemberApiKeyView> = {}): IOrgMemberApiKeyView =>
  ({
    id: 'key-1',
    name: 'Reporting',
    keyPrefix: 'b4m_live_ab',
    scopes: ['read:notebooks', 'write:chat'],
    status: ApiKeyStatus.ACTIVE,
    createdAt: new Date('2026-01-02'),
    creditsUsed: 1234,
    createdBy: { id: 'user-a', name: 'Ada Member' },
    ...overrides,
  }) as IOrgMemberApiKeyView;

const renderSection = () => render(<OrgMemberApiKeysSection organizationId="org-1" />, { wrapper: TestWrapper });

describe('OrgMemberApiKeysSection', () => {
  beforeEach(() => {
    mutateAsync.mockReset().mockResolvedValue(undefined);
    queryState.data = undefined;
  });

  it('renders each key with its creator, scopes and lifetime credits', () => {
    queryState.data = [memberKey(), memberKey({ id: 'key-2', createdBy: { id: 'gone', name: null } })];
    renderSection();
    const row = within(screen.getByTestId('org-member-api-key-row-key-1'));
    expect(row.getByText('Ada Member')).toBeTruthy();
    expect(row.getByText('read:notebooks')).toBeTruthy();
    expect(row.getByText('write:chat')).toBeTruthy();
    expect(row.getByText((1234).toLocaleString())).toBeTruthy();
    expect(within(screen.getByTestId('org-member-api-key-row-key-2')).getByText('Deleted user')).toBeTruthy();
  });

  it('shows the empty state when no member keys are billed to the org', () => {
    queryState.data = [];
    renderSection();
    expect(screen.getByTestId('org-member-api-keys-empty')).toBeTruthy();
    expect(screen.queryByTestId('org-member-api-keys-table')).toBeNull();
  });

  it('revokes the key after the confirmation names it and its creator', async () => {
    queryState.data = [memberKey()];
    renderSection();
    fireEvent.click(screen.getByTestId('org-member-api-key-revoke-btn-key-1'));
    expect(screen.getByTestId('confirmation-dialog').textContent).toContain('"Reporting", created by Ada Member');
    fireEvent.click(screen.getByTestId('confirmation-confirm-btn'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith('key-1'));
  });

  it('does not revoke when the confirmation is cancelled', async () => {
    queryState.data = [memberKey()];
    renderSection();
    fireEvent.click(screen.getByTestId('org-member-api-key-revoke-btn-key-1'));
    fireEvent.click(screen.getByTestId('confirmation-cancel-btn'));
    await waitFor(() => expect(screen.queryByTestId('confirmation-dialog')).toBeNull());
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('offers no revoke for a revoked or expired key', () => {
    queryState.data = [
      memberKey({ id: 'revoked', status: ApiKeyStatus.DISABLED }),
      memberKey({ id: 'expired', expiresAt: new Date('2020-01-01') }),
    ];
    renderSection();
    expect(within(screen.getByTestId('org-member-api-key-row-revoked')).getByText('Revoked')).toBeTruthy();
    expect(within(screen.getByTestId('org-member-api-key-row-expired')).getByText('Expired')).toBeTruthy();
    expect(screen.queryByTestId('org-member-api-key-revoke-btn-revoked')).toBeNull();
    expect(screen.queryByTestId('org-member-api-key-revoke-btn-expired')).toBeNull();
  });
});
