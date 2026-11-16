import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_ROLE_TEMPLATES } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import AdminRolesTab from './AdminRolesTab';

const { getMock, postMock, patchMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: getMock, post: postMock, patch: patchMock, delete: deleteMock },
}));
const user = vi.hoisted(() => ({
  currentUser: { isAdmin: true } as { isAdmin: boolean; adminPermissions?: string[] },
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: user.currentUser }) }));
vi.mock('@client/app/utils/stepUpInterceptor', () => ({
  isStepUpCancelled: (error: unknown) => typeof error === 'object' && error !== null && 'cancelled' in error,
}));

const theme = extendTheme({ ...getThemeConfig() });

const SUPPORT_ID = 'a'.repeat(24);
const BILLING_ID = 'b'.repeat(24);
const roles = [
  { id: SUPPORT_ID, name: 'Support desk', description: 'Front line', permissions: ['support:read'], memberCount: 3 },
  {
    id: BILLING_ID,
    name: 'Billing',
    description: '',
    permissions: ['support:read', 'credits:adjust'],
    memberCount: 0,
  },
];

const checkbox = (testId: string) => within(screen.getByTestId(testId)).getByRole('checkbox', { hidden: true });
const permission = (id: string) => checkbox(`admin-role-permission-${id}`);
const openRow = async (id: string) => fireEvent.click(await screen.findByTestId(`admin-roles-row-${id}`));

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>
        <AdminRolesTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  user.currentUser = { isAdmin: true };
  getMock.mockReset().mockResolvedValue({ data: { roles } });
  postMock.mockReset().mockResolvedValue({ data: roles[0] });
  patchMock.mockReset().mockResolvedValue({ data: roles[0] });
  deleteMock.mockReset().mockResolvedValue({ data: undefined });
});

describe('AdminRolesTab list', () => {
  it('shows each role with its permission and member counts', async () => {
    renderTab();
    const row = await screen.findByTestId(`admin-roles-row-${SUPPORT_ID}`);
    expect(row).toHaveTextContent('Support desk');
    expect(row).toHaveTextContent('Front line');
    expect(screen.getByTestId(`admin-roles-permission-count-${SUPPORT_ID}`)).toHaveTextContent('1');
    expect(screen.getByTestId(`admin-roles-member-count-${SUPPORT_ID}`)).toHaveTextContent('3');
    expect(screen.getByTestId(`admin-roles-permission-count-${BILLING_ID}`)).toHaveTextContent('2');
    expect(screen.getByTestId(`admin-roles-member-count-${BILLING_ID}`)).toHaveTextContent('0');
  });

  it('suggests templates on a fresh instance and creates nothing by itself', async () => {
    getMock.mockResolvedValue({ data: { roles: [] } });
    renderTab();
    expect(await screen.findByText('No roles yet')).toBeInTheDocument();
    expect(screen.getByText(/Support \(read-only\) or Billing/)).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('admin-roles-create-btn')).toHaveLength(1);
  });
});

describe('AdminRolesTab create', () => {
  it('pre-fills the form from a template and creates an ordinary role', async () => {
    renderTab();
    await screen.findByTestId(`admin-roles-row-${SUPPORT_ID}`);
    fireEvent.click(screen.getByTestId('admin-roles-create-btn'));

    const billing = ADMIN_ROLE_TEMPLATES.find(template => template.id === 'billing')!;
    const card = await screen.findByTestId('admin-role-template-billing');
    expect(card).toHaveTextContent(billing.description);
    expect(screen.getByTestId('admin-role-template-billing-permissions')).toHaveTextContent(
      'Support read, Adjust credits'
    );
    fireEvent.click(card);

    expect(screen.getByTestId('admin-role-name-input')).toHaveValue('Billing');
    expect(permission('support:read')).toBeChecked();
    expect(permission('credits:adjust')).toBeChecked();
    expect(permission('users:export')).not.toBeChecked();

    fireEvent.click(screen.getByTestId('admin-role-form-save-btn'));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/admin/admin-roles', {
        name: 'Billing',
        description: billing.description,
        permissions: ['support:read', 'credits:adjust'],
      })
    );
  });

  it('explains what blocks Create until a name and a permission are set', async () => {
    renderTab();
    await screen.findByTestId(`admin-roles-row-${SUPPORT_ID}`);
    fireEvent.click(screen.getByTestId('admin-roles-create-btn'));

    expect(await screen.findByTestId('admin-role-form-hint')).toHaveTextContent('Name the role.');
    fireEvent.change(screen.getByTestId('admin-role-name-input'), { target: { value: 'Ops' } });
    expect(screen.getByTestId('admin-role-form-hint')).toHaveTextContent('Pick at least one permission.');
    expect(screen.getByTestId('admin-role-form-save-btn')).toBeDisabled();
    fireEvent.click(permission('support:read'));
    expect(screen.queryByTestId('admin-role-form-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-role-form-save-btn')).toBeEnabled();
  });
});

describe('AdminRolesTab edit', () => {
  it('saves a rename without asking for a reason', async () => {
    renderTab();
    await openRow(SUPPORT_ID);
    fireEvent.change(await screen.findByTestId('admin-role-name-input'), { target: { value: 'Support team' } });
    fireEvent.click(screen.getByTestId('admin-role-form-save-btn'));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith(`/api/admin/admin-roles/${SUPPORT_ID}`, { name: 'Support team' })
    );
    expect(screen.queryByTestId('admin-role-review-dialog')).not.toBeInTheDocument();
  });

  it('warns how many users a permission change reaches and sends the reason with it', async () => {
    renderTab();
    await openRow(SUPPORT_ID);
    await screen.findByTestId('admin-role-permission-credits:adjust');
    fireEvent.click(permission('credits:adjust'));
    fireEvent.click(screen.getByTestId('admin-role-form-save-btn'));

    const dialog = await screen.findByTestId('admin-role-review-dialog');
    expect(dialog).toHaveTextContent('This changes access for 3 users.');
    expect(screen.getByTestId('admin-role-review-preview-before')).toHaveTextContent('Support read');
    expect(screen.getByTestId('admin-role-review-preview-after')).toHaveTextContent('Support read, Adjust credits');

    const confirm = screen.getByTestId('admin-role-review-dialog-confirm-btn');
    expect(confirm).toBeDisabled();
    expect(patchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('admin-role-review-dialog-reason-input-preset-0'));
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith(`/api/admin/admin-roles/${SUPPORT_ID}`, {
        permissions: ['support:read', 'credits:adjust'],
        reason: 'Role scope updated for new duties',
      })
    );
  });

  it('needs an extra confirmation before granting a sensitive permission', async () => {
    renderTab();
    await openRow(SUPPORT_ID);
    await screen.findByTestId('admin-role-permission-users:export');
    fireEvent.click(permission('users:export'));
    fireEvent.click(screen.getByTestId('admin-role-form-save-btn'));

    await screen.findByTestId('admin-role-sensitive-alert');
    fireEvent.click(screen.getByTestId('admin-role-review-dialog-reason-input-preset-0'));
    const confirm = screen.getByTestId('admin-role-review-dialog-confirm-btn');
    expect(confirm).toBeDisabled();
    expect(screen.getByTestId('admin-role-review-dialog-hint')).toHaveTextContent('Confirm the sensitive permissions');

    fireEvent.click(checkbox('admin-role-sensitive-confirm'));
    expect(confirm).toBeEnabled();
  });

  it('asks again for each sensitive grant after the review is cancelled and reopened', async () => {
    renderTab();
    await openRow(SUPPORT_ID);
    await screen.findByTestId('admin-role-permission-users:export');
    fireEvent.click(permission('users:export'));
    fireEvent.click(screen.getByTestId('admin-role-form-save-btn'));
    await screen.findByTestId('admin-role-sensitive-alert');
    fireEvent.click(checkbox('admin-role-sensitive-confirm'));
    fireEvent.click(screen.getByTestId('admin-role-review-dialog-cancel-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-role-review-dialog')).not.toBeInTheDocument());

    fireEvent.click(permission('users:impersonate'));
    fireEvent.click(screen.getByTestId('admin-role-form-save-btn'));
    await screen.findByTestId('admin-role-sensitive-alert');
    fireEvent.click(screen.getByTestId('admin-role-review-dialog-reason-input-preset-0'));

    expect(checkbox('admin-role-sensitive-confirm')).not.toBeChecked();
    expect(screen.getByTestId('admin-role-review-dialog-confirm-btn')).toBeDisabled();
  });

  it('stays quiet when the verification prompt is dismissed', async () => {
    patchMock.mockRejectedValue(Object.assign(new Error('Re-verify'), { cancelled: true }));
    renderTab();
    await openRow(SUPPORT_ID);
    await screen.findByTestId('admin-role-permission-credits:adjust');
    fireEvent.click(permission('credits:adjust'));
    fireEvent.click(screen.getByTestId('admin-role-form-save-btn'));
    fireEvent.click(await screen.findByTestId('admin-role-review-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('admin-role-review-dialog-confirm-btn'));

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('admin-role-review-dialog-confirm-btn')).toBeEnabled());
    expect(screen.queryByTestId('admin-role-review-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-role-review-dialog')).toBeInTheDocument();
  });

  it('shows a refused save in the dialog and keeps it open', async () => {
    patchMock.mockRejectedValue(new Error('An admin role with this name already exists.'));
    renderTab();
    await openRow(SUPPORT_ID);
    fireEvent.change(await screen.findByTestId('admin-role-name-input'), { target: { value: 'Billing' } });
    fireEvent.click(screen.getByTestId('admin-role-form-save-btn'));

    expect(await screen.findByTestId('admin-role-form-error')).toHaveTextContent('already exists');
    expect(screen.getByTestId('admin-role-form-dialog')).toBeInTheDocument();
  });
});

describe('AdminRolesTab delete', () => {
  const openDelete = async (id: string) => {
    fireEvent.click(await screen.findByTestId(`admin-roles-actions-${id}`));
    fireEvent.click(await screen.findByTestId(`admin-roles-delete-${id}`));
    return screen.findByTestId('admin-role-delete-dialog');
  };

  it('is disabled with an explanation while the role has members', async () => {
    renderTab();
    const dialog = await openDelete(SUPPORT_ID);
    expect(dialog).toHaveTextContent('held by 3 users');
    expect(screen.getByTestId('admin-role-delete-dialog-hint')).toHaveTextContent('still hold this role');
    expect(screen.getByTestId('admin-role-delete-dialog-confirm-btn')).toBeDisabled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('follows a refetched member count when the delete is refused', async () => {
    getMock.mockResolvedValueOnce({ data: { roles } }).mockResolvedValue({
      data: { roles: roles.map(role => (role.id === BILLING_ID ? { ...role, memberCount: 2 } : role)) },
    });
    deleteMock.mockRejectedValue(new Error('Remove this role from its 2 members before deleting it.'));
    renderTab();
    const dialog = await openDelete(BILLING_ID);
    expect(dialog).toHaveTextContent('Nobody holds it');
    fireEvent.change(screen.getByTestId('admin-role-delete-dialog-typed-input'), { target: { value: 'Billing' } });
    fireEvent.click(screen.getByTestId('admin-role-delete-dialog-confirm-btn'));

    await waitFor(() => expect(screen.getByTestId('admin-role-delete-dialog')).toHaveTextContent('held by 2 users'));
    expect(screen.getByTestId('admin-role-delete-dialog-confirm-btn')).toBeDisabled();
    expect(screen.getByTestId('admin-role-delete-error')).toHaveTextContent('2 members');
  });

  it('deletes a role nobody holds once its name is typed', async () => {
    renderTab();
    await openDelete(BILLING_ID);
    const confirm = screen.getByTestId('admin-role-delete-dialog-confirm-btn');
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByTestId('admin-role-delete-dialog-typed-input'), { target: { value: 'Billing' } });
    fireEvent.click(confirm);

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(`/api/admin/admin-roles/${BILLING_ID}`));
  });
});

describe('AdminRolesTab for a delegate', () => {
  beforeEach(() => {
    user.currentUser = { isAdmin: false, adminPermissions: ['support:read'] };
  });

  it('lists roles but offers no create, edit or delete controls', async () => {
    renderTab();
    await screen.findByTestId(`admin-roles-row-${SUPPORT_ID}`);
    expect(screen.queryByTestId('admin-roles-create-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId(`admin-roles-actions-${SUPPORT_ID}`)).not.toBeInTheDocument();
  });

  it('opens a role read-only', async () => {
    renderTab();
    await openRow(SUPPORT_ID);
    expect(await screen.findByTestId('admin-role-name-input')).toHaveAttribute('readonly');
    expect(permission('support:read')).toBeChecked();
    expect(permission('support:read')).toBeDisabled();
    expect(screen.queryByTestId('admin-role-form-save-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-role-form-cancel-btn')).toHaveTextContent('Close');
  });

  it('does not offer to create the first role either', async () => {
    getMock.mockResolvedValue({ data: { roles: [] } });
    renderTab();
    expect(await screen.findByText('No roles yet')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-roles-create-btn')).not.toBeInTheDocument();
  });
});
