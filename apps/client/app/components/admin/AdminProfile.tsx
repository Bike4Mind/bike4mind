import { useAdminProfileModal } from '@client/app/components/admin/AdminProfileModal';
import ManageAccountsIcon from '@mui/icons-material/ManageAccounts';
import { Button } from '@mui/joy';
import React from 'react';

interface AdminProfileProps {
  userId: string;
  size?: 'sm' | 'md' | 'lg';
}

const AdminProfile: React.FC<AdminProfileProps> = ({ userId, size = 'md' }) => {
  const setUserId = useAdminProfileModal(state => state.setUserId);

  return (
    <Button
      data-testid="admin-user-profile-btn"
      color="warning"
      size={size}
      startDecorator={<ManageAccountsIcon />}
      onClick={() => setUserId(userId)}
    >
      Profile
    </Button>
  );
};

export default AdminProfile;
