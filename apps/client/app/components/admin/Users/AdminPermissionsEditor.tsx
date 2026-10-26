import {
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  isValidAdminActionReason,
  type AdminPermissionId,
} from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Button, Checkbox, Stack, Typography } from '@mui/joy';
import { useState } from 'react';
import { toast } from 'sonner';
import { AdminReasonField } from '../shared/AdminReasonField';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import {
  adminRequestErrorMessage,
  invalidateAdminPermissionQueries,
  putAdminPermissions,
} from './adminPermissionsRequest';

export const AdminPermissionsEditor = ({ user }: { user: AdminUserListItem }) => {
  const currentUser = useUser(state => state.currentUser);
  const isSelf = currentUser?.id === user.id;
  const allowed = hasAdminPermission(currentUser, 'settings:manage') && !isSelf;
  const hasSettingsPermission = hasAdminPermission(currentUser, 'settings:manage');
  const [permissions, setPermissions] = useState<AdminPermissionId[]>(user.adminPermissions ?? []);
  const [fullAdmin, setFullAdmin] = useState(user.isAdmin);
  const [reason, setReason] = useState('');
  const queryClient = useQueryClient();
  const savedPermissions = user.adminPermissions ?? [];
  const isDirty =
    fullAdmin !== user.isAdmin ||
    permissions.length !== savedPermissions.length ||
    permissions.some(permission => !savedPermissions.includes(permission));
  const mutation = useMutation({
    mutationFn: async () => {
      if (!hasSettingsPermission) throw new Error('Missing permission: settings:manage');
      if (isSelf) throw new Error('You cannot change your own admin permissions');
      await putAdminPermissions(user.id, { adminPermissions: permissions, isAdmin: fullAdmin, reason });
    },
    onSuccess: async () => {
      await invalidateAdminPermissionQueries(queryClient, user.id);
      setReason('');
      toast.success('Admin permissions updated');
    },
    onError: error => toast.error(adminRequestErrorMessage(error, 'Failed to update admin permissions')),
  });
  return (
    <Stack spacing={1} data-testid="admin-permissions-editor">
      <Typography level="title-sm">Administrative permissions</Typography>
      {!hasSettingsPermission && <Typography color="warning">Missing permission: settings:manage</Typography>}
      {isSelf && <Typography color="warning">You cannot change your own admin permissions</Typography>}
      <Checkbox
        label="Full admin"
        checked={fullAdmin}
        disabled={!allowed || mutation.isPending}
        onChange={event => setFullAdmin(event.target.checked)}
        data-testid="admin-permissions-full-admin"
      />
      {ADMIN_PERMISSIONS.map(permission => (
        <Checkbox
          key={permission}
          label={permission}
          checked={permissions.includes(permission)}
          disabled={!allowed || mutation.isPending}
          onChange={event =>
            setPermissions(previous =>
              event.target.checked ? [...previous, permission] : previous.filter(value => value !== permission)
            )
          }
          data-testid={`admin-permission-${permission}`}
        />
      ))}
      <AdminReasonField value={reason} onChange={setReason} data-testid="admin-permissions-reason" />
      <Button
        disabled={!allowed || !isDirty || !isValidAdminActionReason(reason)}
        loading={mutation.isPending}
        onClick={() => mutation.mutate()}
        data-testid="admin-permissions-save"
      >
        Save admin permissions
      </Button>
    </Stack>
  );
};
