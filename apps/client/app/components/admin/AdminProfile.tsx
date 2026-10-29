import ManageAccountsIcon from '@mui/icons-material/ManageAccounts';
import { Button } from '@mui/joy';
import React from 'react';
import { useOpenUserProfile } from '@client/app/components/admin/Users/Profile/useOpenUserProfile';

interface AdminProfileProps {
  userId: string;
  size?: 'sm' | 'md' | 'lg';
}

const AdminProfile: React.FC<AdminProfileProps> = ({ userId, size = 'md' }) => {
  const openUserProfile = useOpenUserProfile();

  return (
    <Button
      data-testid="admin-user-profile-btn"
      color="warning"
      size={size}
      startDecorator={<ManageAccountsIcon />}
      onClick={() => void openUserProfile(userId)}
    >
      Profile
    </Button>
  );
};

export default AdminProfile;
