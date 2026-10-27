import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import React, { useState } from 'react';
import { Chip, Tooltip } from '@mui/joy';
import CircleIcon from '@mui/icons-material/Circle';
import LoginDetailsModal from './LoginDetailsModal';
import { useGetUserActivityCounters } from '@client/app/hooks/data/user';
import { AuthEvents } from '@bike4mind/common';

interface LoginsViewProps {
  user: AdminUserListItem;
}

const LoginsView: React.FC<LoginsViewProps> = ({ user }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const counters = useGetUserActivityCounters(user.id);
  const logins =
    counters.data?.find(counter => counter.action === AuthEvents.LOGIN || counter.action === AuthEvents.REGISTER)
      ?.count ?? 0;

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
          // The count alone announces as a bare number; Tooltip only sets aria-describedby.
          aria-label={`${logins} logins, view last login details`}
          size="sm"
          variant="soft"
          // Zero is not a fault, so it reads neutral, not red (DESIGN_GUIDE.md, "Status tones").
          color={logins === 0 ? 'neutral' : 'success'}
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
