import { InviteType, Permission } from '@bike4mind/common';
import type { ISharerInviteView } from '@client/app/utils/invitesAPICalls';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PendingInvitationsTable from './PendingInvitationsTable';

const mocks = vi.hoisted(() => ({
  resend: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useResendOrganizationInvite: () => ({ mutate: mocks.resend, isPending: false, variables: undefined }),
}));
vi.mock('@client/app/hooks/data/invites', () => ({
  useCancelInvite: () => ({ mutateAsync: mocks.cancel, isPending: false, variables: undefined }),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => mocks.confirm }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en-US' } }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
  </QueryClientProvider>
);

const invite = (over: Record<string, unknown>): ISharerInviteView =>
  ({
    id: 'inv1',
    type: InviteType.Organization,
    documentId: 'org1',
    permissions: [Permission.read],
    recipients: { pending: ['viewer@example.test'], accepted: [], refused: [] },
    accepted: 0,
    remaining: 1,
    expiresAt: undefined,
    createdAt: new Date('2026-11-10T12:00:00Z'),
    updatedAt: new Date('2026-11-10T12:00:00Z'),
    inviterId: 'owner1',
    inviterName: 'Ada Owner',
    ...over,
  }) as ISharerInviteView;

const renderTable = (props: Partial<Parameters<typeof PendingInvitationsTable>[0]> = {}) =>
  render(
    <PendingInvitationsTable
      organizationId="org1"
      invites={[invite({})]}
      isError={false}
      canManage
      canGrantAdmin
      currentUserId="someone-else"
      {...props}
    />,
    { wrapper: Wrapper }
  );

describe('PendingInvitationsTable', () => {
  beforeEach(() => {
    mocks.resend.mockReset();
    mocks.cancel.mockReset();
    mocks.confirm.mockReset();
  });

  it('shows the invitee, role, sent date and inviter', () => {
    renderTable();
    const row = screen.getByTestId('organization-pending-invite-row');
    expect(row).toHaveTextContent('viewer@example.test');
    expect(row).toHaveTextContent('Viewer');
    expect(row).toHaveTextContent('Nov 10, 2026');
    expect(row).toHaveTextContent('Ada Owner');
    expect(screen.getByTestId('organization-pending-invites')).toHaveTextContent('Pending invitations (1)');
  });

  it('names the viewer as You when they sent the invite', () => {
    renderTable({ currentUserId: 'owner1' });
    expect(within(screen.getByTestId('organization-pending-invite-row')).getByText('You')).toBeTruthy();
  });

  it('resends by address and by user id', () => {
    renderTable({
      invites: [
        invite({
          recipients: { pending: ['typed@example.test', 'user1'], accepted: [], refused: [] },
          recipientUsers: [{ userId: 'user1', name: 'Grace' }],
        }),
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Resend invitation to typed@example.test' }));
    expect(mocks.resend).toHaveBeenLastCalledWith({ email: 'typed@example.test' });
    fireEvent.click(screen.getByRole('button', { name: 'Resend invitation to Grace' }));
    expect(mocks.resend).toHaveBeenLastCalledWith({ userId: 'user1' });
  });

  it('withholds resend of an admin invite from a manager, who may still cancel it', () => {
    renderTable({
      canGrantAdmin: false,
      invites: [invite({ permissions: [Permission.read, Permission.update, Permission.share] })],
    });
    expect(screen.getByTestId('organization-pending-invite-row')).toHaveTextContent('Admin');
    expect(screen.queryByTestId('organization-pending-invite-resend-btn')).toBeNull();
    expect(screen.getByTestId('organization-pending-invite-cancel-btn')).toBeTruthy();
  });

  it('cancels by user id after a confirmation', async () => {
    renderTable({
      invites: [
        invite({
          recipients: { pending: ['user1'], accepted: [], refused: [] },
          recipientUsers: [{ userId: 'user1', name: 'Grace' }],
        }),
      ],
    });
    fireEvent.click(screen.getByTestId('organization-pending-invite-cancel-btn'));
    const { onOk, description } = mocks.confirm.mock.calls[0][0];
    expect(description).toContain('Cancel the invitation to Grace?');
    await onOk();
    expect(mocks.cancel).toHaveBeenCalledWith({ id: 'org1', type: InviteType.Organization, userId: 'user1' });
  });

  it('offers no actions to a viewer who cannot manage invites', () => {
    renderTable({ canManage: false });
    expect(screen.getByTestId('organization-pending-invite-row')).toBeTruthy();
    expect(screen.queryByTestId('organization-pending-invite-resend-btn')).toBeNull();
    expect(screen.queryByTestId('organization-pending-invite-cancel-btn')).toBeNull();
  });

  it('renders nothing with no pending invites, and an error when they fail to load', () => {
    const { container, unmount } = renderTable({ invites: [] });
    expect(container).toBeEmptyDOMElement();
    unmount();
    renderTable({ isError: true });
    expect(screen.getByTestId('organization-pending-invites-error')).toBeTruthy();
  });
});
