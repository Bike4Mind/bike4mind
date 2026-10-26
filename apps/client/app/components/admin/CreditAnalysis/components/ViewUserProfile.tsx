import { hasAdminPermission } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { AdminPermissionBoundary } from '../../shared/AdminPermissionBoundary';
import { useAdminProfileModal } from '@client/app/components/admin/AdminProfileModal';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { Button } from '@mui/joy';
import React from 'react';

interface ViewUserProfileProps {
  userId: string;
  size?: 'sm' | 'md' | 'lg';
}

const ViewUserProfile: React.FC<ViewUserProfileProps> = ({ userId, size = 'md' }) => {
  const setUserId = useAdminProfileModal(state => state.setUserId);

  return (
    <AdminPermissionBoundary permission="settings:manage">
      <Button
        size={size}
        variant="outlined"
        color="neutral"
        startDecorator={<VisibilityIcon />}
        onClick={() => {
          if (hasAdminPermission(useUser.getState().currentUser, 'settings:manage')) setUserId(userId);
        }}
      >
        View
      </Button>
    </AdminPermissionBoundary>
  );
};

export default ViewUserProfile;
