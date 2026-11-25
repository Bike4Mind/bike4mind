import React, { useEffect, useState } from 'react';
import { MenuItem, Stack, Typography } from '@mui/joy';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import {
  useAdminDeleteSpace,
  useAdminRemoveSpaceMember,
  useAdminSpace,
  type AdminSpacePerson,
} from '@client/app/hooks/data/adminSpaces';
import {
  ActionDialog,
  AdminDialog,
  DataTable,
  ErrorState,
  Fact,
  LoadingState,
  SectionCard,
  StatusChip,
} from '../shared';
import { ADMIN_REASON_PRESETS } from '../shared/adminReason';
import { RowActionsMenu } from '../shared/RowActionsMenu';
import { useOpenSpaceId } from './useSpacesTabParams';

const personLabel = (person: AdminSpacePerson) => person.email ?? person.username ?? person.userId;

const ROLE_LABEL: Record<AdminSpacePerson['role'], string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

const SpaceAdminModal: React.FC = () => {
  const { spaceId, setSpaceId } = useOpenSpaceId();
  const query = useAdminSpace(spaceId);
  const removeMember = useAdminRemoveSpaceMember();
  const deleteSpace = useAdminDeleteSpace();
  const [memberToRemove, setMemberToRemove] = useState<AdminSpacePerson | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const isUnknown = isAxiosError(query.error) && query.error.response?.status === 404;
  useEffect(() => {
    if (!spaceId || !isUnknown) return;
    toast.error('That Space could not be found.', { id: 'admin-space-not-found' });
    void setSpaceId(null);
  }, [spaceId, isUnknown, setSpaceId]);

  const detail = query.data?.space.id === spaceId ? query.data : undefined;
  const space = detail?.space;

  const close = () => {
    setMemberToRemove(null);
    setConfirmingDelete(false);
    void setSpaceId(null);
  };

  const handleRemoveMember = async (reason: string) => {
    if (!spaceId || !memberToRemove) return;
    try {
      await removeMember.mutateAsync({ spaceId, userId: memberToRemove.userId, reason });
      setMemberToRemove(null);
    } catch {
      // The mutation toasts the error.
    }
  };

  const handleDelete = async (reason: string) => {
    if (!spaceId) return;
    try {
      await deleteSpace.mutateAsync({ spaceId, reason });
      close();
    } catch {
      // The mutation toasts the error.
    }
  };

  return (
    <AdminDialog open={!!spaceId} onClose={close} title="Space" width={960} data-testid="admin-space-modal">
      {space && detail ? (
        <Stack gap={2}>
          <Stack direction="row" alignItems="center" gap={1}>
            <Typography level="title-lg" sx={{ mr: 'auto' }} data-testid="admin-space-name">
              {space.name}
            </Typography>
            <RowActionsMenu testId="admin-space-header-actions" ariaLabel={`Actions for ${space.name}`}>
              <MenuItem color="danger" onClick={() => setConfirmingDelete(true)} data-testid="admin-space-delete-item">
                Delete Space
              </MenuItem>
            </RowActionsMenu>
          </Stack>

          <SectionCard title="Details" data-testid="admin-space-details">
            <Fact label="Owner" data-testid="admin-space-owner">
              {personLabel(space.owner)}
            </Fact>
            <Fact label="Created">{space.createdAt ? new Date(space.createdAt).toLocaleString() : null}</Fact>
            <Fact label="Parent organization">{space.parentOrganizationId}</Fact>
            <Fact label="Members">{space.memberCount}</Fact>
            <Fact label="Pending invites" data-testid="admin-space-pending-invites">
              {detail.pendingInviteCount}
            </Fact>
          </SectionCard>

          <SectionCard title="Members" body="custom" data-testid="admin-space-members">
            <DataTable
              label="Space members"
              rows={[space.owner, ...space.members]}
              getRowId={person => person.userId}
              rowTestId={person => `admin-space-member-${person.userId}`}
              columns={[
                { id: 'person', label: 'Member', render: person => personLabel(person) },
                { id: 'role', label: 'Role', render: person => ROLE_LABEL[person.role] },
                {
                  id: 'joinedVia',
                  label: 'Joined by',
                  render: person => person.joinedVia ?? '-',
                },
                {
                  id: 'joinedAt',
                  label: 'Joined',
                  render: person => (person.joinedAt ? new Date(person.joinedAt).toLocaleDateString() : '-'),
                },
              ]}
              rowActions={person =>
                person.role === 'owner' ? null : (
                  <RowActionsMenu
                    testId={`admin-space-member-actions-${person.userId}`}
                    ariaLabel={`Actions for ${personLabel(person)}`}
                  >
                    <MenuItem
                      color="danger"
                      onClick={() => setMemberToRemove(person)}
                      data-testid={`admin-space-remove-member-${person.userId}`}
                    >
                      Remove from Space
                    </MenuItem>
                  </RowActionsMenu>
                )
              }
              pagination={false}
              onRetry={() => void query.refetch()}
              minWidth="36rem"
            />
          </SectionCard>

          <SectionCard title="Domains" body="custom" data-testid="admin-space-domains">
            {detail.domains.length === 0 ? (
              <Typography level="body-sm" sx={{ p: 2 }}>
                This Space holds no domains.
              </Typography>
            ) : (
              <Stack gap={1} sx={{ p: 2 }}>
                {detail.domains.map(claim => (
                  <Stack key={claim.id} direction="row" alignItems="center" gap={1}>
                    <Typography level="body-sm">{claim.domain}</Typography>
                    <StatusChip tone={claim.status === 'verified' ? 'good' : 'warn'} label={claim.status} />
                  </Stack>
                ))}
              </Stack>
            )}
          </SectionCard>
        </Stack>
      ) : query.isError && !isUnknown ? (
        <ErrorState message="This Space could not be loaded." onRetry={() => void query.refetch()} />
      ) : (
        <LoadingState label="Loading Space" />
      )}

      <ActionDialog
        open={!!memberToRemove}
        onClose={() => setMemberToRemove(null)}
        title="Remove member"
        description={
          memberToRemove && space
            ? `${personLabel(memberToRemove)} loses access to ${space.name} and its skills. Their pending invite is cancelled. They cannot rejoin by link, only through a new named invite. Their own listings stay in the Space.`
            : undefined
        }
        reasonPresets={ADMIN_REASON_PRESETS.spaceMemberRemoval}
        confirmLabel="Remove member"
        tone="danger"
        pending={removeMember.isPending}
        onConfirm={handleRemoveMember}
        data-testid="admin-space-remove-member-dialog"
      />

      <ActionDialog
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title="Delete Space"
        description={
          space
            ? `Every member of ${space.name} loses access. Its invites and links are revoked and its verified domains are released. The owner is told a platform administrator deleted it. This cannot be undone.`
            : undefined
        }
        reasonPresets={ADMIN_REASON_PRESETS.spaceDeletion}
        confirmLabel="Delete Space"
        tone="danger"
        typedConfirm={space ? { expected: space.name, noun: 'Space name' } : undefined}
        pending={deleteSpace.isPending}
        onConfirm={handleDelete}
        data-testid="admin-space-delete-dialog"
      />
    </AdminDialog>
  );
};

export default SpaceAdminModal;
