import { hasAdminPermission } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { useMigrateUsers } from '@client/app/utils/userAPICalls';
import ForwardToInboxIcon from '@mui/icons-material/ForwardToInbox';
import { Button, Tooltip, Stack, Typography } from '@mui/joy';
import React from 'react';

interface MigrateAgainProps {
  user: AdminUserListItem;
  size?: 'sm' | 'md' | 'lg';
}

const MigrateAgain: React.FC<MigrateAgainProps> = ({ user, size = 'md' }) => {
  const canManage = useUser(state => hasAdminPermission(state.currentUser, 'settings:manage'));
  const { name, email, username, organizationId } = user;
  const { mutate: migrateUsersMutation, isPending } = useMigrateUsers();

  const handleRemindUser = () => {
    if (!canManage) return;
    console.log(`Reminding user ${username} to log in.`);
    if (email) {
      const migrateUser = [{ name: name, email: email }];
      migrateUsersMutation({ usersData: migrateUser, sendEmail: true, orgId: organizationId?.id ?? '' });
    } else {
      console.error(`User ${username} does not have a valid email address.`);
    }
  };

  return (
    <Stack>
      {!canManage && (
        <Typography level="body-sm" color="warning">
          Missing permission: settings:manage
        </Typography>
      )}
      <Tooltip title="Customer is MIA! Send another migrate email!">
        <Button
          data-testid="admin-user-migrate-again-btn"
          startDecorator={<ForwardToInboxIcon />}
          size={size}
          onClick={handleRemindUser}
          disabled={isPending || !canManage}
          sx={{ whiteSpace: 'nowrap' }}
        >
          Migrate Again
        </Button>
      </Tooltip>
    </Stack>
  );
};

export default MigrateAgain;
