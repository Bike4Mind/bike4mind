import { FC, useState } from 'react';
import { Box, Breadcrumbs, Button, Grid, IconButton, Stack, Typography } from '@mui/joy';
import { blackAlpha } from '../../utils/themes/colors';
import { ArrowBack, Edit, Assignment, CheckCircle, Schedule, CalendarToday, SmartToy } from '@mui/icons-material';
import { IResearchAgent, ResearchTaskStatus } from '@bike4mind/common';
import { ResearchTaskList, ResearchTaskDetail } from '../ResearchTasks';
import { useListResearchTasksByAgentId } from '@client/app/hooks/data/researchTasks';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ResearchTaskFormModal from '../ResearchTasks/FormModal';

interface ResearchAgentContentProps {
  agent: IResearchAgent;
  onEditAgent: () => void;
  onDeleteAgent: () => void;
  onCreateTask: () => void;
}

const ResearchAgentContent: FC<ResearchAgentContentProps> = ({ agent, onEditAgent, onCreateTask, onDeleteAgent }) => {
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const { data: tasks = [], isFetching: isFetchingTasks } = useListResearchTasksByAgentId(agent.id);
  const [isFormModalOpen, setIsFormModalOpen] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);

  const handleTaskClick = (taskId: string) => {
    setSelectedTaskId(taskId);
  };

  const handleBack = () => {
    setSelectedTaskId(undefined);
  };

  const handleFormModalClose = () => {
    setIsFormModalOpen(false);
    setEditingTaskId(null);
  };

  const handleTaskCreated = (taskId: string) => {
    setSelectedTaskId(taskId);
    console.log(`🎯 Auto-selected newly created research task: ${taskId}`);
  };

  const handleEditTask = (taskId: string) => {
    setEditingTaskId(taskId);
    setIsFormModalOpen(true);
  };

  const selectedTask = tasks.find(task => task.id === selectedTaskId);

  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(task => task.status === ResearchTaskStatus.COMPLETED).length;
  const inProgressTasks = tasks.filter(
    task => task.status === ResearchTaskStatus.PROCESSING || task.status === ResearchTaskStatus.PENDING
  ).length;

  if (selectedTask) {
    return (
      <Stack spacing={2} sx={{ height: '100%' }}>
        {/* Navigation Section */}
        <Box sx={{ p: 2 }}>
          <Stack spacing={1}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Button
                variant="plain"
                color="neutral"
                startDecorator={<ArrowBack />}
                onClick={handleBack}
                sx={{ mr: 1 }}
              >
                Back
              </Button>
              <Breadcrumbs size="sm">
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <SmartToy sx={{ fontSize: 16, color: 'neutral.500' }} />
                  <Typography color="neutral">{agent.name}</Typography>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Assignment sx={{ fontSize: 16, color: 'primary.500' }} />
                  <Typography>{selectedTask.title}</Typography>
                </Box>
              </Breadcrumbs>
            </Box>
          </Stack>
        </Box>

        {/* Task Detail Section */}
        <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
          <ResearchTaskDetail task={selectedTask} onEdit={() => handleEditTask(selectedTask.id)} />
        </Box>
        <ResearchTaskFormModal
          open={isFormModalOpen}
          onClose={handleFormModalClose}
          onTaskCreated={handleTaskCreated}
          taskId={editingTaskId || undefined}
          researchAgentId={agent.id}
        />
      </Stack>
    );
  }

  return (
    <Stack spacing={2} sx={{ height: '100%' }}>
      {/* Header Section */}
      <Box sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <SmartToy sx={{ fontSize: 28, color: 'primary.500' }} />
            <Typography level="h4">{agent.name}</Typography>
            <IconButton variant="plain" color="neutral" size="sm" onClick={onEditAgent}>
              <Edit />
            </IconButton>
          </Box>
          <Typography level="body-md" color="neutral">
            {agent.description}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CalendarToday sx={{ fontSize: 16, color: 'neutral.500' }} />
            <Typography level="body-sm" color="neutral">
              Created on {new Date(agent.createdAt).toLocaleDateString()}
            </Typography>
          </Box>

          {/* Danger Zone */}
          <Box sx={{ pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
            <Button
              variant="outlined"
              color="danger"
              onClick={onDeleteAgent}
              size="sm"
              startDecorator={<DeleteOutlineIcon sx={{ fontSize: 16 }} />}
              sx={{
                '--Button-gap': '8px',
                fontSize: '14px',
                '&:hover': {
                  bgcolor: 'danger.softHoverBg',
                },
              }}
            >
              Delete Agent
            </Button>
          </Box>
        </Stack>
      </Box>

      {/* Stats Section */}
      <Box sx={{ px: 2 }}>
        <Grid container spacing={2}>
          <Grid xs={12} sm={4}>
            <Box
              sx={{
                p: 2,
                bgcolor: 'background.surface',
                borderRadius: '8px',
                boxShadow: `0 2px 8px ${blackAlpha[0][8]}`,
                transition: 'all 0.2s ease-in-out',
                '&:hover': {
                  transform: 'translateY(-2px)',
                  boxShadow: `0 4px 16px ${blackAlpha[0][12]}`,
                },
                display: 'flex',
                alignItems: 'center',
                gap: 2,
              }}
            >
              <Assignment sx={{ fontSize: 32, color: 'primary.500' }} />
              <Box>
                <Typography level="body-sm" color="neutral">
                  Total Tasks
                </Typography>
                <Typography level="h4" color="primary">
                  {totalTasks}
                </Typography>
              </Box>
            </Box>
          </Grid>
          <Grid xs={12} sm={4}>
            <Box
              sx={{
                p: 2,
                bgcolor: 'background.surface',
                borderRadius: '8px',
                boxShadow: `0 2px 8px ${blackAlpha[0][8]}`,
                transition: 'all 0.2s ease-in-out',
                '&:hover': {
                  transform: 'translateY(-2px)',
                  boxShadow: `0 4px 16px ${blackAlpha[0][12]}`,
                },
                display: 'flex',
                alignItems: 'center',
                gap: 2,
              }}
            >
              <CheckCircle sx={{ fontSize: 32, color: 'success.500' }} />
              <Box>
                <Typography level="body-sm" color="neutral">
                  Completed
                </Typography>
                <Typography level="h4" color="success">
                  {completedTasks}
                </Typography>
              </Box>
            </Box>
          </Grid>
          <Grid xs={12} sm={4}>
            <Box
              sx={{
                p: 2,
                bgcolor: 'background.surface',
                borderRadius: '8px',
                boxShadow: `0 2px 8px ${blackAlpha[0][8]}`,
                transition: 'all 0.2s ease-in-out',
                '&:hover': {
                  transform: 'translateY(-2px)',
                  boxShadow: `0 4px 16px ${blackAlpha[0][12]}`,
                },
                display: 'flex',
                alignItems: 'center',
                gap: 2,
              }}
            >
              <Schedule sx={{ fontSize: 32, color: 'warning.500' }} />
              <Box>
                <Typography level="body-sm" color="neutral">
                  In Progress
                </Typography>
                <Typography level="h4" color="warning">
                  {inProgressTasks}
                </Typography>
              </Box>
            </Box>
          </Grid>
        </Grid>
      </Box>

      {/* Task List Section */}
      <Box sx={{ flexGrow: 1, overflow: 'hidden' }}>
        <ResearchTaskList
          tasks={tasks}
          isFetching={isFetchingTasks}
          selectedTaskId={selectedTaskId}
          onTaskClick={handleTaskClick}
          onCreateTask={onCreateTask}
          researchAgentId={agent.id}
        />
      </Box>
    </Stack>
  );
};

export default ResearchAgentContent;
