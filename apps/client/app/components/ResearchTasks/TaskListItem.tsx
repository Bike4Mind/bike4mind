import { FC } from 'react';
import { Box, Button, ListItem, ListItemButton, Stack, Typography } from '@mui/joy';
import { IResearchTask, ResearchTaskStatus, ResearchTaskType } from '@bike4mind/common';
import TaskStatusBadge from './TaskStatusBadge';
import PublicIcon from '@mui/icons-material/Public';
import StorageIcon from '@mui/icons-material/Storage';
import { Edit, Delete, Refresh, CalendarToday } from '@mui/icons-material';
import { useRemoveResearchTask, useRetryResearchTask } from '@client/app/hooks/data/researchTasks';
import { useConfirmation } from '@client/app/hooks/useConfirmation';

interface TaskListItemProps {
  task: IResearchTask;
  isSelected?: boolean;
  onClick?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

const TaskListItem: FC<TaskListItemProps> = ({ task, isSelected, onClick, onEdit }) => {
  const confirm = useConfirmation();
  const { mutateAsync: deleteTask } = useRemoveResearchTask();
  const { mutateAsync: retryTask, isPending } = useRetryResearchTask();

  const getTaskTypeIcon = () => {
    switch (task.type) {
      case ResearchTaskType.SCRAPE:
        return <PublicIcon sx={{ fontSize: 16 }} />;
      case ResearchTaskType.SALESFORCE:
        return <StorageIcon sx={{ fontSize: 16 }} />;
      default:
        return null;
    }
  };

  const getTaskTypeLabel = () => {
    switch (task.type) {
      case ResearchTaskType.SCRAPE:
        return 'Web Scrape';
      case ResearchTaskType.SALESFORCE:
        return 'Salesforce';
      default:
        return null;
    }
  };

  const handleDelete = async () => {
    confirm({
      type: 'danger',
      title: 'Delete this task?',
      description: 'Are you sure you want to delete this task?',
      okLabel: 'Delete',
      onOk: async () => {
        await deleteTask(task);
      },
    });
  };

  return (
    <ListItem>
      <ListItemButton
        onClick={onClick}
        selected={isSelected}
        sx={{
          cursor: 'pointer',
          gap: 2,
          border: '1px solid',
          borderColor: 'divider',
          '&:hover': {
            bgcolor: 'background.level1',
            borderColor: 'neutral.outlinedHoverBorder',
            '& .actions': {
              opacity: 1,
            },
          },
        }}
      >
        <Stack spacing={1} sx={{ flex: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography level="title-sm" noWrap>
              {task.title}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <TaskStatusBadge status={task.status} />
              <Box
                className="actions"
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  opacity: 0,
                  transition: 'opacity 0.2s',
                }}
              >
                {task.status === ResearchTaskStatus.FAILED && (
                  <Button
                    variant="outlined"
                    color="primary"
                    size="sm"
                    loading={isPending}
                    startDecorator={!isPending && <Refresh fontSize="small" />}
                    onClick={e => {
                      e.stopPropagation();
                      retryTask(task);
                    }}
                  >
                    Retry
                  </Button>
                )}
                <Button
                  variant="outlined"
                  color="neutral"
                  size="sm"
                  startDecorator={<Edit fontSize="small" />}
                  onClick={e => {
                    e.stopPropagation();
                    onEdit?.();
                  }}
                >
                  Edit
                </Button>
                <Button
                  variant="outlined"
                  color="danger"
                  size="sm"
                  startDecorator={<Delete fontSize="small" />}
                  onClick={e => {
                    e.stopPropagation();
                    handleDelete();
                  }}
                >
                  Delete
                </Button>
              </Box>
            </Box>
          </Box>
          <Typography level="body-sm" noWrap>
            {task.description}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                color: 'neutral.500',
                bgcolor: 'background.level1',
                p: 0.5,
                borderRadius: 'sm',
              }}
            >
              {getTaskTypeIcon()}
              <Typography level="body-xs">{getTaskTypeLabel()}</Typography>
            </Box>
            <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
              •
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <CalendarToday sx={{ fontSize: 12, color: 'neutral.500' }} />
              <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
                Created {new Date(task.createdAt).toLocaleString()}
              </Typography>
            </Box>
          </Box>
        </Stack>
      </ListItemButton>
    </ListItem>
  );
};

export default TaskListItem;
