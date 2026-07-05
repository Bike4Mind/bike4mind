import React, { useState } from 'react';
import { Tooltip, Stack, Button } from '@mui/joy';
import { IUserDocument, WithOrgRef } from '@bike4mind/common';
import LoginDetailsModal from './LoginDetailsModal';
import { useGetUserActivityCounters } from '@client/app/hooks/data/user';
import { AuthEvents } from '@bike4mind/common';

interface LoginsViewProps {
  user: WithOrgRef<IUserDocument>;
}

const LoginsView: React.FC<LoginsViewProps> = ({ user }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const counters = useGetUserActivityCounters(user.id);
  const logins =
    counters.data?.find(counter => counter.action === AuthEvents.LOGIN || counter.action === AuthEvents.REGISTER)
      ?.count ?? 0;
  const isAlert = logins === 0;

  const lastLoginRecord = user.loginRecords?.reduce(
    (prev, current) => (prev.loginTime > current.loginTime ? prev : current),
    user.loginRecords[0]
  );

  const handleOpenModal = () => {
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
  };

  return (
    <>
      <Stack direction="row" spacing={2} display={'flex'} justifyContent={'flex-start'}>
        <Tooltip title="Tap for Last Login Details">
          <Button
            size="md"
            variant="plain"
            startDecorator={isAlert ? '🚨' : '🟢'}
            color={isAlert ? 'danger' : 'neutral'}
            onClick={handleOpenModal}
          >
            {logins}
          </Button>
        </Tooltip>
      </Stack>
      <LoginDetailsModal open={isModalOpen} onClose={handleCloseModal} user={user} lastLoginRecord={lastLoginRecord} />
    </>
  );
};

export default LoginsView;
