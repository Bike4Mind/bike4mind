import { useAdminGetUserApiKeys } from '@client/app/hooks/data/userApiKeys';
import { isRevoked } from '@client/app/utils/apiKeyRevocation';
import { hasAdminPermission, isValidAdminActionReason } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Stack, Typography } from '@mui/joy';
import { useState } from 'react';
import { toast } from 'sonner';
import { AdminReasonField } from '../shared/AdminReasonField';

export const AdminUserKeyRevocation = ({ userId }: { userId: string }) => {
  const currentUser = useUser(state => state.currentUser);
  const canRead = hasAdminPermission(currentUser, 'support:read');
  const canRevoke = hasAdminPermission(currentUser, 'keys:revoke');
  const [reason, setReason] = useState('');
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();
  const queryKey = ['admin', 'user-api-keys', userId];
  const keys = useAdminGetUserApiKeys(canRead && expanded ? userId : undefined);
  const mutation = useMutation({
    mutationFn: async (keyId: string) => {
      if (!canRevoke) throw new Error('Missing permission: keys:revoke');
      if (!isValidAdminActionReason(reason)) throw new Error('A reason is required');
      await api.post(`/api/admin/user-api-keys/${keyId}/revoke`, { reason: reason.trim() });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: ['user-api-keys'] }),
      ]);
      setReason('');
      toast.success('API key revoked');
    },
    onError: () => toast.error('Failed to revoke API key'),
  });
  const pendingKeyId = mutation.isPending ? mutation.variables : undefined;
  if (!expanded) {
    return (
      <Stack spacing={1} data-testid="admin-user-key-revocation">
        <Typography level="title-sm">User API keys</Typography>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          onClick={() => setExpanded(true)}
          data-testid="admin-user-key-revocation-expand"
        >
          Show API keys
        </Button>
      </Stack>
    );
  }
  return (
    <Stack spacing={1} data-testid="admin-user-key-revocation">
      <Typography level="title-sm">User API keys</Typography>
      {!canRevoke && <Typography color="warning">Missing permission: keys:revoke</Typography>}
      {keys.isLoading && <Typography>Loading API keys...</Typography>}
      {keys.isError && <Button onClick={() => keys.refetch()}>Retry loading API keys</Button>}
      {keys.data?.apiKeys.length === 0 && <Typography>No API keys</Typography>}
      <AdminReasonField value={reason} onChange={setReason} data-testid="admin-key-revoke-reason" />
      {keys.data?.apiKeys.map(key => (
        <Stack key={key.id} direction="row" spacing={1}>
          <Typography>{key.name}</Typography>
          <Button
            disabled={!canRevoke || !isValidAdminActionReason(reason) || isRevoked(key)}
            loading={pendingKeyId === key.id}
            onClick={() => mutation.mutate(key.id)}
            data-testid={`admin-key-revoke-${key.id}`}
          >
            {isRevoked(key) ? 'Revoked' : 'Revoke key'}
          </Button>
        </Stack>
      ))}
    </Stack>
  );
};
