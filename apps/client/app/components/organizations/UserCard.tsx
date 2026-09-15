import { InviteType, IUserDocument, Permission, IOrganizationDocument } from '@bike4mind/common';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { useCancelInvite } from '@client/app/hooks/data/invites';
import { getAppFileUrl } from '@client/app/utils/s3';
import { Box, Avatar, Stack, IconButton, Dropdown, MenuButton, Menu, MenuItem, Chip, Typography } from '@mui/joy';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { FC, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useUser } from '@client/app/contexts/UserContext';
import { useRemoveMemberFromOrganization, useLeaveOrganization } from '@client/app/hooks/data/organizations';
import { useNavigate } from '@tanstack/react-router';

interface OrganizationUserCardProps {
  organization: IOrganizationDocument;
  user: IUserDocument & { status: 'accepted' | 'pending'; permissions: Permission[]; usedCredits: number };
  /** Permissions the current viewer holds for this org (from parent context). */
  userPermissions: Permission[];
}

const OrganizationUserCard: FC<OrganizationUserCardProps> = ({ organization, user, userPermissions }) => {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { currentUser } = useUser();
  const { id: organizationId } = organization;
  const queryClient = useQueryClient();
  const avatarUrl = user.photoUrl ? getAppFileUrl({ key: user.photoUrl }) : '';
  const { mutateAsync: cancelInvite } = useCancelInvite({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users', 'organization', organizationId, 'pending'] });
      toast.success('Invite cancelled successfully');
    },
    onError: err => {
      toast.error(err.message);
    },
  });
  const isOwner = user?.id === organization.userId;
  const { mutateAsync: removeMember } = useRemoveMemberFromOrganization();
  const { mutateAsync: leaveOrganization } = useLeaveOrganization();

  const confirm = useConfirmation();
  const chips = (
    <Stack direction="row" spacing={1}>
      {user.isBanned && (
        <Chip size="sm" variant="soft" color="danger">
          Deactivated
        </Chip>
      )}
      {user.status === 'pending' ? (
        <Chip size="sm" variant="soft" color="warning">
          Pending
        </Chip>
      ) : isOwner ? (
        <Chip size="sm" variant="soft" color="primary">
          Owner
        </Chip>
      ) : (
        user.permissions.map(permission => (
          <Chip key={permission} size="sm" variant="soft">
            {permission === Permission.share ? 'Admin' : permission === Permission.update ? 'Editor' : 'Viewer'}
          </Chip>
        ))
      )}
    </Stack>
  );
  const handleRemoveMember = useCallback(
    async (userId: string) => {
      confirm({
        title: 'Remove Member',
        description: 'Are you sure you want to remove this member?',
        type: 'danger',
        onOk: async () => {
          await removeMember({ organizationId, userId });
        },
      });
    },
    [organizationId, confirm, removeMember]
  );

  const handleLeaveOrganization = useCallback(async () => {
    confirm({
      title: 'Leave Organization',
      description: 'Are you sure you want to leave this organization?',
      type: 'danger',
      onOk: async () => {
        await leaveOrganization({ organizationId });
        navigate({ to: '/organizations' });
      },
    });
  }, [confirm, organizationId, leaveOrganization, navigate]);

  // canManage is true when the viewer holds update or share permissions for this org.
  // The admin panel passes these to any system admin; the b4m client passes them only
  // to the org owner, so admins who are merely members cannot revoke/cancel here.
  const canManage = userPermissions.includes(Permission.update) || userPermissions.includes(Permission.share);

  const canRevoke = canManage && user.status === 'accepted';
  const canLeave = user.status === 'accepted' && currentUser?.id === user.id;
  const canCancelInvite = user.status === 'pending' && canManage;

  const actionsMenu = (canRevoke || canLeave || canCancelInvite) && user.id !== organization.userId && (
    <Dropdown>
      <MenuButton
        className="organization-user-card-menu-button"
        slots={{ root: IconButton }}
        slotProps={{ root: { variant: 'outlined', size: 'sm' } }}
      >
        <MoreVertIcon />
      </MenuButton>
      <Menu placement="bottom-end" sx={{ zIndex: 9999 }}>
        {canCancelInvite && (
          <MenuItem
            onClick={() =>
              confirm({
                title: 'Cancel Invite',
                description: 'Are you sure you want to cancel this invite?',
                type: 'danger',
                onOk: () =>
                  cancelInvite({
                    id: organizationId,
                    type: InviteType.Organization,
                    email: user.email || undefined,
                  }),
              })
            }
          >
            Cancel Invite
          </MenuItem>
        )}
        {canRevoke && <MenuItem onClick={() => handleRemoveMember(user.id)}>Revoke Access</MenuItem>}
        {canLeave && <MenuItem onClick={handleLeaveOrganization}>Leave Organization</MenuItem>}
      </Menu>
    </Dropdown>
  );

  if (isMobile) {
    return (
      <Box
        className="organization-user-card-container"
        sx={theme => ({
          borderRadius: '8px',
          border: '1px solid',
          borderColor: 'divider',
          backgroundColor: theme.palette.primary.softBg,
          padding: '10px 12px',
        })}
      >
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0, flex: 1 }}>
            <Avatar className="organization-user-card-avatar" size="sm" variant="soft" src={avatarUrl}>
              {user.name?.charAt(0).toUpperCase()}
            </Avatar>
            <Stack sx={{ minWidth: 0 }}>
              <Box
                className="organization-user-card-name"
                sx={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {user.name}
              </Box>
              <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
                {chips}
                <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                  {user.usedCredits} credits
                </Typography>
              </Stack>
            </Stack>
          </Stack>
          <Box sx={{ flexShrink: 0 }}>{actionsMenu}</Box>
        </Stack>
      </Box>
    );
  }

  return (
    <Box
      className="organization-user-card-container"
      sx={theme => ({
        borderRadius: '8px',
        display: 'grid',
        gridTemplateColumns: '2fr 1fr 1fr',
        width: '100%',
        border: '1px solid',
        borderColor: 'divider',
        backgroundColor: theme.palette.primary.softBg,
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 15px',
        position: 'relative',
      })}
    >
      <Box
        className="organization-user-card-user-info"
        display="flex"
        alignItems={'center'}
        sx={{ justifyContent: 'space-between' }}
        gap="10px"
        zIndex={2}
      >
        <Stack className="organization-user-card-user-stack" direction="row" spacing={2} alignItems="center">
          <Avatar className="organization-user-card-avatar" size="sm" variant="soft" src={avatarUrl}>
            {user.name?.charAt(0).toUpperCase()}
          </Avatar>
          <Stack>
            <Stack direction="row" spacing={1} alignItems="center">
              <Box className="organization-user-card-name">{user.name}</Box>
              {chips}
            </Stack>
          </Stack>
        </Stack>
      </Box>

      <Box className="organization-user-card-credits" display="flex" justifyContent="center" alignItems="center">
        {user.usedCredits}
      </Box>
      <Box className="organization-user-card-actions" display="flex" gap="10px" justifyContent="flex-end" zIndex={2}>
        {actionsMenu}
      </Box>
    </Box>
  );
};

export default OrganizationUserCard;
