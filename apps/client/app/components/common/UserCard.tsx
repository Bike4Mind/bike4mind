import { IUserDocument } from '@bike4mind/common';
import {
  Avatar,
  Box,
  Checkbox,
  CircularProgress,
  IconButton,
  Stack,
  Dropdown,
  MenuButton,
  Menu,
  MenuItem,
  Tooltip,
} from '@mui/joy';
import { DeleteOutline, MoreVert, Check, VisibilityOutlined } from '@mui/icons-material';
import { green, orange } from '../../utils/themes/colors';
import { FC, useMemo } from 'react';
import { getAppFileUrl } from '@client/app/utils/s3';
import { useNavigate } from '@tanstack/react-router';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { useGetUserByEmail } from '@client/app/hooks/data/user';

const UserCard: FC<{
  user: Pick<IUserDocument, 'name' | 'email' | 'photoUrl'> & { id?: string };
  onClick?: () => void;
  checked?: boolean;
  inviteStatus?: 'accepted' | 'pending';
  onDelete?: () => void;
  onRevoke?: () => void;
  isDeleting?: boolean;
  isRevoking?: boolean;
  /** Additional elements to display next to the user's name (e.g., permission chips) */
  chips?: React.ReactNode;
  hideEmail?: boolean;
}> = ({ user, onClick, checked, inviteStatus, onDelete, isDeleting, onRevoke, isRevoking, chips, hideEmail }) => {
  const navigate = useNavigate();
  const avatarUrl = user.photoUrl ? getAppFileUrl({ key: user.photoUrl }) : '';
  const confirm = useConfirmation();

  // For pending items, try to resolve the actual user via email
  const userByEmail = useGetUserByEmail(user.email || '', {
    enabled: inviteStatus === 'pending' && !!user.email,
  }).data;

  const dropdownOptions = useMemo(() => {
    const options = [];

    if (inviteStatus === 'pending' && onDelete) {
      options.push(
        <MenuItem color="danger" disabled={isDeleting} onClick={onDelete}>
          {isDeleting ? (
            <CircularProgress className="user-card-loading" size="sm" style={{ marginRight: 8 }} />
          ) : (
            <DeleteOutline sx={{ fontSize: 16, marginRight: 1 }} />
          )}
          {isDeleting ? 'Removing...' : 'Remove invite'}
        </MenuItem>
      );
    }

    if (onRevoke) {
      options.push(
        <MenuItem
          onClick={() => {
            confirm({
              title: 'Remove Access',
              description: `Are you sure you want to revoke access for ${user.name}`,
              type: 'danger',
              onOk: () => onRevoke(),
            });
          }}
          disabled={isRevoking}
        >
          {isRevoking ? (
            <CircularProgress size="sm" style={{ marginRight: 8 }} />
          ) : (
            <DeleteOutline sx={{ fontSize: 16, marginRight: 1 }} />
          )}
          {isRevoking ? 'Revoking...' : 'Revoke access'}
        </MenuItem>
      );
    }

    return options;
  }, [inviteStatus, onDelete, onRevoke, isDeleting, isRevoking, user.name, confirm]);

  // Resolve the correct user id for profile link
  const resolvedUserId = useMemo(() => {
    return inviteStatus === 'pending' ? userByEmail?.id : user.id;
  }, [inviteStatus, userByEmail?.id, user.id]);

  return (
    <Box
      className="user-card-container"
      sx={theme => ({
        borderRadius: '8px',
        display: 'flex',
        width: '100%',
        border: '1px solid',
        borderColor: theme.palette.common.userCard.borderColor,
        backgroundColor: theme.palette.primary.softBg,
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '20px',
        position: 'relative',
      })}
    >
      <Box
        sx={{
          width: '100%',
          height: '100%',
          backgroundColor: 'transparent',
          position: 'absolute',
          left: 0,
          top: 0,
          zIndex: 1,
        }}
        onClick={onClick}
      />
      <Box display="flex" alignItems={'center'} sx={{ justifyContent: 'space-between' }} gap="20px" zIndex={2}>
        {inviteStatus === 'pending' || inviteStatus === 'accepted' ? (
          <Box
            sx={{
              width: 24,
              height: 24,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: inviteStatus === 'pending' ? orange[425] : green[800],
              background: 'transparent',
              borderRadius: '4px',
              mr: '4px',
            }}
          >
            <Check sx={{ fontSize: 18 }} />
          </Box>
        ) : (
          <Checkbox checked={checked} onChange={onClick} />
        )}
        <Stack direction="row" spacing={2} alignItems="center">
          <Avatar className="user-card-avatar" size="sm" variant="soft" src={avatarUrl}>
            {user.name?.charAt(0).toUpperCase()}
          </Avatar>
          <Stack direction="column" gap="12px" sx={{ justifyContent: 'center' }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Box
                sx={{
                  fontSize: '18px',
                  lineHeight: '18px',
                  color: 'text.primary',
                }}
              >
                {user.name}
              </Box>
              {chips}
            </Stack>
            {!hideEmail && (
              <Box
                sx={{
                  fontSize: '14px',
                  lineHeight: '14px',
                  color: 'text.primary50',
                }}
              >
                {user.email}
              </Box>
            )}
          </Stack>
        </Stack>
      </Box>

      <Box display="flex" gap="10px" zIndex={2} alignItems="center">
        {inviteStatus && (
          <Box
            sx={{
              color: 'white',
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
              background: inviteStatus === 'pending' ? orange[425] : green[800],
              marginRight: '8px',
            }}
          >
            {inviteStatus}
          </Box>
        )}
        {dropdownOptions.length > 0 && (
          <Dropdown>
            <MenuButton
              className="user-card-menu-button"
              slots={{ root: IconButton }}
              slotProps={{ root: { variant: 'outlined' } }}
            >
              <MoreVert />
            </MenuButton>
            <Menu className="user-card-menu" placement="bottom-end">
              {dropdownOptions}
            </Menu>
          </Dropdown>
        )}
        {resolvedUserId && (
          <Tooltip className="user-card-view-tooltip" title="View">
            <IconButton
              className="user-card-view-button"
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
              <VisibilityOutlined sx={{ fontSize: 20 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>
    </Box>
  );
};

export default UserCard;
