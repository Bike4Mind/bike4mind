import { IUserDocument, WithOrgRef } from '@bike4mind/common';
import { useMigrateUsers } from '@client/app/utils/userAPICalls';
import ForwardToInboxIcon from '@mui/icons-material/ForwardToInbox';
import { Button, Tooltip } from '@mui/joy';
import React from 'react';

interface MigrateAgainProps {
  user: WithOrgRef<IUserDocument>;
  size?: 'sm' | 'md' | 'lg';
}

const MigrateAgain: React.FC<MigrateAgainProps> = ({ user, size = 'md' }) => {
  const { name, email, username, organizationId } = user;
  const { mutate: migrateUsersMutation, isPending } = useMigrateUsers();

  const handleRemindUser = () => {
    console.log(`Reminding user ${username} to log in.`);
    if (email) {
      const migrateUser = [{ name: name, email: email }];
      migrateUsersMutation({ usersData: migrateUser, sendEmail: true, orgId: organizationId?.id ?? '' });
    } else {
      console.error(`User ${username} does not have a valid email address.`);
    }
  };

  return (
    <Tooltip title="Customer is MIA! Send another migrate email!">
      <Button
        startDecorator={<ForwardToInboxIcon />}
        size={size}
        onClick={handleRemindUser}
        disabled={isPending}
        sx={{ whiteSpace: 'nowrap' }}
      >
        Migrate Again
      </Button>
    </Tooltip>
  );
};

export default MigrateAgain;
