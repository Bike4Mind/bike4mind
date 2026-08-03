import React, { useState } from 'react';
import { Chip, Tooltip } from '@mui/joy';
import CircleIcon from '@mui/icons-material/Circle';
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
      <Tooltip title="Tap for Last Login Details">
        <Chip
          data-testid="admin-user-logins-chip"
          size="sm"
          variant="soft"
          color={isAlert ? 'danger' : 'success'}
          startDecorator={<CircleIcon sx={{ fontSize: 8 }} />}
          onClick={handleOpenModal}
        >
          {logins}
        </Chip>
      </Tooltip>
      <LoginDetailsModal open={isModalOpen} onClose={handleCloseModal} user={user} lastLoginRecord={lastLoginRecord} />
    </>
  );
};

export default LoginsView;
