import { useState } from 'react';
import { Button, ListDivider, MenuItem, Stack, Typography } from '@mui/joy';
import { isFullAdmin } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useAdminRoles, type AdminRoleRow } from '@client/app/hooks/data/adminRoles';
import { getErrorMessage } from '@client/app/utils/error';
import { AdminPageHeader, DataTable, EmptyState, RowActionsMenu, type DataColumn } from '../shared';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';
import { RoleDeleteDialog } from './RoleDeleteDialog';
import { RoleFormDialog } from './RoleFormDialog';

// Dialogs hold the role id, not the row, so a refetch (a member assigned meanwhile) reaches them.
type DialogState = { kind: 'create' } | { kind: 'edit' | 'view' | 'delete'; roleId: string } | null;

export default function AdminRolesTab() {
  const { currentUser } = useUser();
  const canEdit = isFullAdmin(currentUser);
  const roles = useAdminRoles();
  const [dialog, setDialog] = useState<DialogState>(null);
  const close = () => setDialog(null);
  const activeRole =
    dialog && dialog.kind !== 'create' ? roles.data?.find(role => role.id === dialog.roleId) : undefined;

  const columns: DataColumn<AdminRoleRow>[] = [
    {
      id: 'name',
      label: 'Name',
      width: '16rem',
      render: role => (
        <Typography level="body-md" sx={{ color: 'admin.ink', fontWeight: 500 }}>
          {role.name}
        </Typography>
      ),
      sortValue: role => role.name.toLowerCase(),
    },
    {
      id: 'description',
      label: 'Description',
      render: role =>
        role.description || (
          <Typography level="body-md" sx={{ color: 'admin.inkMuted' }}>
            -
          </Typography>
        ),
    },
    {
      id: 'permissions',
      label: 'Permissions',
      numeric: true,
      width: '8rem',
      render: role => (
        <span data-testid={`admin-roles-permission-count-${role.id}`}>{role.permissions.length.toLocaleString()}</span>
      ),
      sortValue: role => role.permissions.length,
    },
    {
      id: 'members',
      label: 'Members',
      numeric: true,
      width: '8rem',
      render: role => (
        <span data-testid={`admin-roles-member-count-${role.id}`}>{role.memberCount.toLocaleString()}</span>
      ),
      sortValue: role => role.memberCount,
    },
  ];

  const createButton = (label: string) => (
    <Button onClick={() => setDialog({ kind: 'create' })} data-testid="admin-roles-create-btn">
      {label}
    </Button>
  );

  return (
    <Stack gap={ADMIN_REGION_GAP} data-testid="admin-roles-tab">
      <AdminPageHeader
        title="Roles"
        count={roles.data?.length}
        description="A role grants its permissions to everyone who holds it."
        // The empty state carries its own create button, and a view has at most one primary.
        actions={canEdit && roles.data?.length !== 0 ? createButton('Create role') : undefined}
      />
      <DataTable
        label="Admin roles"
        rows={roles.data ?? []}
        columns={columns}
        getRowId={role => role.id}
        loading={roles.isLoading}
        error={roles.error ? getErrorMessage(roles.error) : undefined}
        onRetry={() => void roles.refetch()}
        pagination={false}
        testId="admin-roles-table"
        rowTestId={role => `admin-roles-row-${role.id}`}
        onRowActivate={role => setDialog({ kind: canEdit ? 'edit' : 'view', roleId: role.id })}
        rowActions={
          canEdit
            ? role => (
                <RowActionsMenu
                  testId={`admin-roles-actions-${role.id}`}
                  ariaLabel={`Actions for ${role.name}`}
                  stopRowClick
                >
                  <MenuItem
                    onClick={() => setDialog({ kind: 'edit', roleId: role.id })}
                    data-testid={`admin-roles-edit-${role.id}`}
                  >
                    Edit role
                  </MenuItem>
                  <ListDivider />
                  <MenuItem
                    color="danger"
                    onClick={() => setDialog({ kind: 'delete', roleId: role.id })}
                    data-testid={`admin-roles-delete-${role.id}`}
                  >
                    Delete role
                  </MenuItem>
                </RowActionsMenu>
              )
            : undefined
        }
        empty={
          <EmptyState
            title="No roles yet"
            description="Start from a template such as Support (read-only) or Billing. Nothing is created automatically."
            action={
              canEdit ? (
                createButton('Create from a template')
              ) : (
                <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
                  A full administrator can create the first role.
                </Typography>
              )
            }
          />
        }
      />

      {dialog?.kind === 'create' && <RoleFormDialog mode="create" onClose={close} />}
      {activeRole && (dialog?.kind === 'edit' || dialog?.kind === 'view') && (
        <RoleFormDialog mode={dialog.kind} role={activeRole} onClose={close} />
      )}
      {activeRole && dialog?.kind === 'delete' && <RoleDeleteDialog role={activeRole} onClose={close} />}
    </Stack>
  );
}
