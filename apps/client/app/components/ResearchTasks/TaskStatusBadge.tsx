import { FC } from 'react';
import { Chip } from '@mui/joy';
import { ResearchTaskStatus } from '@bike4mind/common';
import { CheckCircle, Schedule, Error, AccessTime } from '@mui/icons-material';

interface TaskStatusBadgeProps {
  status: ResearchTaskStatus;
}

const TaskStatusBadge: FC<TaskStatusBadgeProps> = ({ status }) => {
  const getStatusConfig = () => {
    switch (status) {
      case ResearchTaskStatus.COMPLETED:
        return {
          color: 'success' as const,
          label: 'Completed',
          icon: <CheckCircle sx={{ fontSize: 14 }} />,
        };
      case ResearchTaskStatus.PROCESSING:
        return {
          color: 'primary' as const,
          label: 'Processing',
          icon: <Schedule sx={{ fontSize: 14 }} />,
        };
      case ResearchTaskStatus.FAILED:
        return {
          color: 'danger' as const,
          label: 'Failed',
          icon: <Error sx={{ fontSize: 14 }} />,
        };
      case ResearchTaskStatus.PENDING:
        return {
          color: 'neutral' as const,
          label: 'Pending',
          icon: <AccessTime sx={{ fontSize: 14 }} />,
        };
      default:
        return {
          color: 'neutral' as const,
          label: status,
          icon: <AccessTime sx={{ fontSize: 14 }} />,
        };
    }
  };

  const { color, label, icon } = getStatusConfig();

  return (
    <Chip variant="soft" size="sm" color={color} startDecorator={icon} sx={{ gap: 0.5 }}>
      {label}
    </Chip>
  );
};

export default TaskStatusBadge;
