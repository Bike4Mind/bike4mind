import { useState } from 'react';
import { Button, FormControl, FormHelperText, FormLabel, Input, MenuItem, Stack, Typography } from '@mui/joy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  OAUTH_CLIENT_MAX_ROLES,
  oauthClientRoleSchema,
  type OAuthClientRole,
  type OAuthClientRoleHolderView,
  type OAuthClientView,
} from '@bike4mind/common';
import {
  addOAuthClientRole,
  fetchOAuthClientRoles,
  removeOAuthClientRole,
} from '@client/app/utils/oauthClientAPICalls';
import { getErrorMessage } from '@client/app/utils/error';
import { ADMIN_REASON_PRESETS, ActionDialog, DataTable, EmptyState, SectionCard, type DataColumn } from './shared';
import { RowActionsMenu } from './shared/RowActionsMenu';

export const OAUTH_CLIENT_ROLES_QUERY_KEY = 'admin-oauth-client-roles';

const holderName = (holder: OAuthClientRoleHolderView) => holder.email ?? holder.name ?? holder.userId;

/** Why the new role cannot be added yet, or null when it can. */
export function newRoleBlockedReason(draft: OAuthClientRole, existing: readonly OAuthClientRole[]): string | null {
  if (existing.length >= OAUTH_CLIENT_MAX_ROLES) return `A client can offer at most ${OAUTH_CLIENT_MAX_ROLES} roles.`;
  const parsed = oauthClientRoleSchema.safeParse(draft);
  if (!parsed.success) return parsed.error.issues[0].message;
  if (existing.some(role => role.key === parsed.data.key))
    return `This client already has a role "${parsed.data.key}".`;
  return null;
}

/**
 * The roles one OAuth client offers and who holds each. Roles are added and removed here; people get
 * them from their admin profile. Removing a role also takes it from everyone who holds it.
 */
export function OAuthClientRolesSection({ client, onClose }: { client: OAuthClientView; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<OAuthClientRole>({ key: '', label: '' });
  const [removeTarget, setRemoveTarget] = useState<OAuthClientRole | null>(null);

  const query = useQuery({
    queryKey: [OAUTH_CLIENT_ROLES_QUERY_KEY, client.id],
    queryFn: () => fetchOAuthClientRoles(client.id),
  });
  const roles = query.data?.roles ?? [];
  const holders = query.data?.holders ?? [];
  const holderCounts = query.data?.holderCounts ?? {};
  const holderCount = (role: OAuthClientRole) => holderCounts[role.key] ?? 0;
  const refresh = () => queryClient.invalidateQueries({ queryKey: [OAUTH_CLIENT_ROLES_QUERY_KEY, client.id] });

  const addMutation = useMutation({
    mutationFn: (reason: string) => addOAuthClientRole(client.id, { ...draft, reason }),
  });
  const removeMutation = useMutation({
    mutationFn: ({ key, reason }: { key: string; reason: string }) => removeOAuthClientRole(client.id, key, reason),
  });

  const openAdd = () => {
    setDraft({ key: '', label: '' });
    setAdding(true);
  };

  const confirmAdd = async (reason: string) => {
    try {
      const role = draft.key.trim();
      await addMutation.mutateAsync(reason);
      setAdding(false);
      void refresh();
      toast.success(`Added the role ${role} to ${client.name}`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  const confirmRemove = async (role: OAuthClientRole, reason: string) => {
    try {
      await removeMutation.mutateAsync({ key: role.key, reason });
      setRemoveTarget(null);
      void refresh();
      toast.success(`Removed the role ${role.key} from ${client.name}`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  const columns: DataColumn<OAuthClientRole>[] = [
    {
      id: 'key',
      label: 'Key',
      width: '10rem',
      render: role => (
        <Typography level="body-sm" sx={{ fontFamily: 'monospace' }} data-testid={`oauth-client-role-key-${role.key}`}>
          {role.key}
        </Typography>
      ),
    },
    { id: 'label', label: 'Label', width: '12rem', render: role => role.label },
    {
      id: 'holders',
      label: 'Held by',
      wrap: true,
      render: role => {
        const names = holders.filter(h => h.role === role.key).map(holderName);
        const more = holderCount(role) - names.length;
        return (
          <Typography
            level="body-sm"
            sx={names.length ? undefined : { color: 'admin.inkMuted' }}
            data-testid={`oauth-client-role-holders-${role.key}`}
          >
            {names.length ? `${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}` : '-'}
          </Typography>
        );
      },
    },
  ];

  return (
    <>
      <SectionCard
        title={`Roles: ${client.name}`}
        body="custom"
        action={
          <Stack direction="row" gap={0.5}>
            <Button size="sm" variant="plain" color="neutral" onClick={openAdd} data-testid="oauth-client-role-add-btn">
              Add role
            </Button>
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={onClose}
              data-testid="oauth-client-roles-close-btn"
            >
              Close
            </Button>
          </Stack>
        }
        data-testid="oauth-client-roles-section"
      >
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted', px: 2, pt: 1.5 }}>
          {`Roles ${client.name} will be able to read for its users once role claims are enabled (client ID ${client.clientId}). Assign them from a user's profile.`}
        </Typography>
        <DataTable
          label={`Roles of ${client.name}`}
          testId="oauth-client-roles-table"
          rows={roles}
          columns={columns}
          getRowId={role => role.key}
          rowTestId={role => `oauth-client-role-row-${role.key}`}
          loading={query.isPending}
          error={query.isError ? `Could not load roles: ${getErrorMessage(query.error)}` : undefined}
          onRetry={() => void query.refetch()}
          empty={
            <EmptyState
              title="No roles yet"
              description="Add a role for this app to read from its users."
              action={
                <Button size="sm" variant="outlined" onClick={openAdd} data-testid="oauth-client-role-empty-add-btn">
                  Add role
                </Button>
              }
            />
          }
          rowActions={role => (
            <RowActionsMenu testId={`oauth-client-role-actions-${role.key}`} ariaLabel={`Actions for ${role.key}`}>
              <MenuItem onClick={() => setRemoveTarget(role)} data-testid={`oauth-client-role-remove-${role.key}`}>
                Remove role
              </MenuItem>
            </RowActionsMenu>
          )}
          pagination={false}
          maxHeight="none"
          framed={false}
        />
      </SectionCard>

      <ActionDialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add role"
        description={`${client.name} will be able to read the role for anyone it is assigned to once role claims are enabled. Other clients, including other stages of the same app, will not see it.`}
        reasonPresets={ADMIN_REASON_PRESETS.oauthClientRoleAdd}
        confirmLabel="Add role"
        blockedReason={newRoleBlockedReason(draft, roles)}
        pending={addMutation.isPending}
        onConfirm={confirmAdd}
        data-testid="oauth-client-role-add-modal"
      >
        <Stack spacing={1.5}>
          <FormControl required>
            <FormLabel>Key</FormLabel>
            <Input
              value={draft.key}
              onChange={e => setDraft(d => ({ ...d, key: e.target.value }))}
              placeholder="admin"
              slotProps={{ input: { 'data-testid': 'oauth-client-role-key-input' } }}
            />
            <FormHelperText>Lower-case letters, digits, - and _. The app reads this value.</FormHelperText>
          </FormControl>
          <FormControl required>
            <FormLabel>Label</FormLabel>
            <Input
              value={draft.label}
              onChange={e => setDraft(d => ({ ...d, label: e.target.value }))}
              placeholder="Administrator"
              slotProps={{ input: { 'data-testid': 'oauth-client-role-label-input' } }}
            />
          </FormControl>
        </Stack>
      </ActionDialog>

      {removeTarget && (
        <ActionDialog
          open
          onClose={() => setRemoveTarget(null)}
          title="Remove role"
          description={`Remove ${removeTarget.key} from ${client.name}? ${
            holderCount(removeTarget) === 1 ? '1 person loses it' : `${holderCount(removeTarget)} people lose it`
          } now, and adding the role back does not restore who held it.`}
          reasonPresets={ADMIN_REASON_PRESETS.oauthClientRoleRemove}
          tone="danger"
          confirmLabel="Remove role"
          pending={removeMutation.isPending}
          onConfirm={reason => confirmRemove(removeTarget, reason)}
          data-testid="oauth-client-role-remove-modal"
        />
      )}
    </>
  );
}
