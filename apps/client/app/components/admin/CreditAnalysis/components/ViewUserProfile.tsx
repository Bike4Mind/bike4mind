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
    <Button
      size={size}
      variant="outlined"
      color="neutral"
      startDecorator={<VisibilityIcon />}
      onClick={() => setUserId(userId)}
    >
      View
    </Button>
  );
};

export default ViewUserProfile;
