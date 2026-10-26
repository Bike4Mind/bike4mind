import { hasAdminPermission } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useAdminProfileModal } from '@client/app/components/admin/AdminProfileModal';
import ManageAccountsIcon from '@mui/icons-material/ManageAccounts';
import { Button, Stack, Typography } from '@mui/joy';
import React from 'react';

interface AdminProfileProps {
  userId: string;
  size?: 'sm' | 'md' | 'lg';
}

const AdminProfile: React.FC<AdminProfileProps> = ({ userId, size = 'md' }) => {
  const canManage = useUser(state => hasAdminPermission(state.currentUser, 'settings:manage'));
  const setUserId = useAdminProfileModal(state => state.setUserId);

  return (
    <Stack>
      {!canManage && (
        <Typography level="body-sm" color="warning">
          Missing permission: settings:manage
        </Typography>
      )}
      <Button
        disabled={!canManage}
        data-testid="admin-user-profile-btn"
        color="warning"
        size={size}
        startDecorator={<ManageAccountsIcon />}
        onClick={() => {
          if (canManage) setUserId(userId);
        }}
      >
        Profile
      </Button>
    </Stack>
  );
};

export default AdminProfile;
