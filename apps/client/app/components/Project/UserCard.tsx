import { IUserDocument } from '@bike4mind/common';
import {
  Avatar,
  Box,
  CircularProgress,
  IconButton,
  Stack,
  Dropdown,
  MenuButton,
  Menu,
  MenuItem,
  Tooltip,
} from '@mui/joy';
import { greenAlpha, orange } from '@client/app/utils/themes/colors';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { FC, useMemo } from 'react';
import { getAppFileUrl } from '@client/app/utils/s3';
import { useNavigate } from '@tanstack/react-router';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { useGetUserByEmail } from '@client/app/hooks/data/user';
import { useUser } from '@client/app/contexts/UserContext';

const UserCard: FC<{
  user: Pick<IUserDocument, 'name' | 'email' | 'photoUrl'> & { id?: string };
  onClick?: () => void;
  checked?: boolean;
  inviteStatus?: 'accepted' | 'pending';
  onDelete?: () => void;
  onRevoke?: () => void;
  isDeleting?: boolean;
  isRevoking?: boolean;
}> = ({ user, onClick, checked, inviteStatus, onDelete, isDeleting, onRevoke, isRevoking }) => {
  useUser(); // Invoked for context side-effect; return value intentionally unused
  const navigate = useNavigate();
  const avatarUrl = user.photoUrl ? getAppFileUrl({ key: user.photoUrl }) : '';
  const confirm = useConfirmation();
  const userData =
    useGetUserByEmail(user.email || '', {
      enabled: inviteStatus === 'pending',
    }).data || user;

  const dropdownOptions = useMemo(() => {
    const options = [];
    if (inviteStatus === 'pending' && onDelete) {
      options.push(
        <MenuItem key={user.id} color="danger" disabled={isDeleting} onClick={onDelete}>
          {isDeleting ? <CircularProgress size="sm" /> : <DeleteOutline fontSize="small" />}
          {isDeleting ? 'Removing...' : 'Remove invite'}
        </MenuItem>
      );
    }
    if (onRevoke) {
      options.push(
        <MenuItem
          key={userData?.id}
          onClick={() => {
            confirm({
              title: 'Remove Project Access',
              description: `Are you sure you want to revoke access for ${userData?.name}`,
              type: 'danger',
              onOk: () => onRevoke(),
            });
          }}
          disabled={isRevoking}
        >
          {isRevoking ? <CircularProgress size="sm" /> : <DeleteOutline fontSize="small" />}
          {isRevoking ? 'Revoking...' : 'Revoke access'}
        </MenuItem>
      );
    }
    return options;
  }, [inviteStatus, onDelete, onRevoke, isDeleting, isRevoking, confirm, user.id, userData]);

  // Use the real user id for the View link: resolve from userData when pending
  const resolvedUserId = useMemo(() => {
    return inviteStatus === 'pending' ? userData?.id : user.id;
  }, [inviteStatus, userData?.id, user.id]);

  return (
    <Box
      className="project-user-card"
      sx={theme => ({
        borderRadius: '8px',
        display: 'flex',
        width: '100%',
        border: '1px solid',
        borderColor: theme.palette.project.border,
        backgroundColor: theme.palette.primary.softBg,
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '20px',
        position: 'relative',
        flexDirection: 'row',
        gap: '0',
      })}
    >
      {/* Left: Pending tag (if any), Avatar, Name, Email */}
      <Box
        className="project-user-card-content"
        display="flex"
        alignItems="center"
        gap="20px"
        sx={{ maxWidth: { xs: '70%', sm: '100%' } }}
      >
        <Avatar
          className="project-user-card-avatar"
          size="sm"
          variant="soft"
          src={avatarUrl}
          sx={{ width: 40, height: 40, minWidth: 40, minHeight: 40, maxWidth: 40, maxHeight: 40 }}
        >
          {userData?.name?.charAt(0).toUpperCase()}
        </Avatar>
        <Stack className="project-user-card-info" gap="12px" direction="row" alignItems="center">
          <Stack className="project-user-card-details" gap="12px">
            <Box
              className="project-user-card-name"
              component="label"
              sx={theme => ({
                fontSize: '18px',
                lineHeight: '18px',
                color: theme.palette.text.primary,
              })}
            >
              {inviteStatus === 'pending' ? userData?.email : userData?.name}
            </Box>
            <Box
              className="project-user-card-email"
              sx={{
                fontSize: '14px',
                lineHeight: '14px',
                color: 'text.primary50',
              }}
            >
              {inviteStatus === 'pending' ? 'Pending Invite' : userData?.email}
            </Box>
          </Stack>
        </Stack>
      </Box>
      {/* Right: Actions */}
      <Box className="project-user-card-actions" display="flex" gap="16px" alignItems="center">
        {inviteStatus && (
          <Box
            className="project-user-card-status"
            sx={{
              color: inviteStatus === 'pending' ? 'white' : 'success.softColor',
              px: 1.5,
              py: 0.5,
              fontSize: '12px',
              fontWeight: 600,
              textTransform: 'capitalize',
              minWidth: '80px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '6px',
              background: inviteStatus === 'pending' ? orange[425] : greenAlpha[600][12],
            }}
          >
            {inviteStatus}
          </Box>
        )}
        {dropdownOptions.length > 0 && (
          <Dropdown>
            <Tooltip className="project-user-card-tooltip" title="More">
              <MenuButton
                className="project-user-card-menu-button"
                slots={{ root: IconButton }}
                slotProps={{
                  root: {
                    variant: 'outlined',
                    sx: {
                      borderRadius: '8px',
                      width: 36,
                      height: 36,
                      minWidth: 36,
                      minHeight: 36,
                      maxWidth: 36,
                      maxHeight: 36,
                      p: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    },
                  },
                }}
              >
                <MoreVertIcon sx={{ fontSize: 20, width: 20, height: 20 }} />
              </MenuButton>
            </Tooltip>
            <Menu className="project-user-card-menu" placement="bottom-end">
              {dropdownOptions}
            </Menu>
          </Dropdown>
        )}
        {resolvedUserId && (
          <Tooltip className="project-user-card-view-tooltip" title="View">
            <IconButton
              className="project-user-card-view-button"
              onClick={() => navigate({ to: '/profile/$id', params: { id: resolvedUserId } })}
              variant="outlined"
              sx={{
                borderRadius: '8px',
                width: 36,
                height: 36,
                minWidth: 36,
                minHeight: 36,
                maxWidth: 36,
                maxHeight: 36,
                p: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <VisibilityOutlinedIcon sx={{ fontSize: 20, width: 20, height: 20 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>
    </Box>
  );
};

export default UserCard;
