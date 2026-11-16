import { useState } from 'react';
import { Alert } from '@mui/joy';
import { useDeleteAdminRole, type AdminRoleRow } from '@client/app/hooks/data/adminRoles';
import { getErrorMessage } from '@client/app/utils/error';
import { ActionDialog } from '../shared';
import { pluralUsers } from './roleModel';

export function RoleDeleteDialog({ role, onClose }: { role: AdminRoleRow; onClose: () => void }) {
  const remove = useDeleteAdminRole();
  const [error, setError] = useState<string | null>(null);
  const held = role.memberCount > 0;

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Delete role"
      description={
        held
          ? `${role.name} is held by ${pluralUsers(role.memberCount)}. Remove it from them before deleting it.`
          : `Deleting ${role.name} cannot be undone. Nobody holds it, so no one loses access.`
      }
      reasonPresets={[]}
      reasonRequired={false}
      confirmLabel="Delete role"
      tone="danger"
      typedConfirm={{ expected: role.name, noun: 'role name' }}
      blockedReason={held ? `Disabled while ${pluralUsers(role.memberCount)} still hold this role.` : null}
      pending={remove.isPending}
      onConfirm={async () => {
        setError(null);
        try {
          await remove.mutateAsync(role.id);
          onClose();
        } catch (caught) {
          setError(getErrorMessage(caught));
        }
      }}
      data-testid="admin-role-delete-dialog"
    >
      {error && (
        <Alert color="danger" data-testid="admin-role-delete-error">
          {error}
        </Alert>
      )}
    </ActionDialog>
  );
}
