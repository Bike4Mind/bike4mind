import {
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  isValidAdminActionReason,
  type AdminPermissionId,
} from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { api } from '@client/app/contexts/ApiContext';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Button, Checkbox, Stack, Typography } from '@mui/joy';
import { useState } from 'react';
import { toast } from 'sonner';
import { AdminReasonField } from '../shared/AdminReasonField';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';

export const AdminPermissionsEditor = ({ user }: { user: AdminUserListItem }) => {
  const currentUser = useUser(state => state.currentUser);
  const allowed = hasAdminPermission(currentUser, 'settings:manage');
  const [permissions, setPermissions] = useState<AdminPermissionId[]>(user.adminPermissions ?? []);
  const [fullAdmin, setFullAdmin] = useState(user.isAdmin);
  const [reason, setReason] = useState('');
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async () => {
      if (!allowed) throw new Error('Missing permission: settings:manage');
      await api.put(`/api/admin/users/${user.id}/permissions`, {
        adminPermissions: permissions,
        isAdmin: fullAdmin,
        reason: reason.trim(),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['users'] }),
        queryClient.invalidateQueries({ queryKey: ['user', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['identify'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'user-entitlements', user.id] }),
      ]);
      setReason('');
      toast.success('Admin permissions updated');
    },
    onError: () => toast.error('Failed to update admin permissions'),
  });
  return (
    <Stack spacing={1} data-testid="admin-permissions-editor">
      <Typography level="title-sm">Administrative permissions</Typography>
      {!allowed && <Typography color="warning">Missing permission: settings:manage</Typography>}
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
        disabled={!allowed || !isValidAdminActionReason(reason)}
        loading={mutation.isPending}
        onClick={() => mutation.mutate()}
        data-testid="admin-permissions-save"
      >
        Save admin permissions
      </Button>
    </Stack>
  );
};
