import { Modal, ModalClose, ModalDialog, Box, Stack, Typography, Button, List, CircularProgress } from '@mui/joy';
import { FC, useState, useMemo, useEffect } from 'react';
import ResearchTaskDetail from './Detail';
import FilterBar from './FilterBar';
import SearchInput from './SearchInput';
import { IResearchTaskScrape, ResearchTaskStatus, ResearchTaskType } from '@bike4mind/common';
import TaskListItem from './TaskListItem';
import ResearchTaskFormModal from './FormModal';
import EditIcon from '@mui/icons-material/Edit';
import TaskStatusBadge from './TaskStatusBadge';
import { useSearchResearchTasks, useGetResearchTask } from '@client/app/hooks/data/researchTasks';

interface ResearchTaskModalProps {
  open: boolean;
  onClose: () => void;
  researchAgentId: string;
}

const ResearchTaskModal: FC<ResearchTaskModalProps> = ({ open, onClose, researchAgentId }) => {
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [formModalOpen, setFormModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ResearchTaskStatus | null>(null);
  const [typeFilter, setTypeFilter] = useState<ResearchTaskType | null>(null);
  const [page, setPage] = useState(1);
  const limit = 20;

  useEffect(() => {
    setPage(1);
  }, [searchQuery, statusFilter, typeFilter]);

  const handleCreateTask = () => {
    setSelectedTaskId(undefined);
    setFormModalOpen(true);
  };

  const handleTaskCreated = (taskId: string) => {
    setSelectedTaskId(taskId);
    console.log(`🎯 Auto-selected newly created research task from modal: ${taskId}`);
  };

  const {
    data: tasksData,
    isLoading: isLoadingTasks,
    error: tasksError,
  } = useSearchResearchTasks({
    search: searchQuery,
    page,
    limit,
    orderBy: { by: 'createdAt', direction: 'desc' },
  });

  const { data: selectedTask, isLoading: isLoadingTask } = useGetResearchTask(researchAgentId, selectedTaskId);

  const isScrapeTask = selectedTask?.type === ResearchTaskType.SCRAPE;

  const tasksDataItems = tasksData?.data;
  const filteredTasks = useMemo(() => {
    if (!tasksDataItems) return [];

    return tasksDataItems.filter(task => {
      const matchesStatus = !statusFilter || task.status === statusFilter;
      const matchesType = !typeFilter || task.type === typeFilter;
      return matchesStatus && matchesType;
    });
  }, [tasksDataItems, statusFilter, typeFilter]);

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.target as HTMLDivElement;
    const isNearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 100;

    if (isNearBottom && tasksData?.hasMore && !isLoadingTasks) {
      setPage(prev => prev + 1);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <ModalDialog
        sx={{
          width: '1200px',
          height: '80vh',
          maxHeight: '900px',
          display: 'flex',
          flexDirection: 'row',
          gap: 2,
          overflow: 'hidden',
          p: 2,
        }}
      >
        <ModalClose />

        {/* Side Navigation */}
        <Box
          sx={{
            width: '350px',
            display: 'flex',
            flexDirection: 'column',
            borderRight: '1px solid',
            borderColor: 'divider',
            pr: 2,
          }}
        >
          {/* Header */}
          <Box sx={{ mb: 2 }}>
            <Typography level="h4">Research Tasks</Typography>
          </Box>

          {/* Search and Filters */}
          <Stack spacing={2} mb={3} sx={{ flexShrink: 0 }}>
            <Button onClick={handleCreateTask} sx={{ width: '100%' }}>
              Create Task
            </Button>
            <SearchInput value={searchQuery} onChange={setSearchQuery} />
            <FilterBar
              status={statusFilter}
              type={typeFilter}
              onStatusChange={setStatusFilter}
              onTypeChange={setTypeFilter}
            />
          </Stack>

          {/* Task List */}
          <Box sx={{ overflow: 'auto', flexGrow: 1 }} onScroll={handleScroll}>
            {isLoadingTasks && page === 1 ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
                <CircularProgress />
              </Box>
            ) : tasksError ? (
              <Typography level="body-lg" textAlign="center" color="danger">
                Failed to load tasks. Please try again.
              </Typography>
            ) : (
              <List
                sx={{
                  '--List-gap': '8px',
                  '--ListItem-paddingY': '1rem',
                }}
              >
                {filteredTasks.length === 0 ? (
                  <Typography level="body-lg" textAlign="center">
                    No tasks found.{' '}
                    {tasksData?.total === 0 ? 'Create your first research task!' : 'Try adjusting your filters.'}
                  </Typography>
                ) : (
                  <>
                    {filteredTasks.map(task => (
                      <TaskListItem
                        key={task.id}
                        task={task}
                        onClick={() => setSelectedTaskId(task.id)}
                        isSelected={task.id === selectedTaskId}
                        onEdit={() => {
                          setSelectedTaskId(task.id);
                          setFormModalOpen(true);
                        }}
                      />
                    ))}
                    {isLoadingTasks && page > 1 && (
                      <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
                        <CircularProgress size="sm" />
                      </Box>
                    )}
                  </>
                )}
              </List>
            )}
          </Box>
        </Box>

        {/* Content Area */}
        <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
          {isLoadingTask ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
              <CircularProgress />
            </Box>
          ) : selectedTask && isScrapeTask ? (
            <ResearchTaskDetail task={selectedTask as IResearchTaskScrape} onEdit={() => setFormModalOpen(true)} />
          ) : selectedTask ? (
            <Box
              sx={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                p: 2,
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <Typography level="h4">{selectedTask.title}</Typography>
                  <TaskStatusBadge status={selectedTask.status} />
                </Box>
                <Button
                  variant="outlined"
                  color="neutral"
                  startDecorator={<EditIcon sx={{ fontSize: 16 }} />}
                  onClick={() => setFormModalOpen(true)}
                >
                  Edit Task
                </Button>
              </Box>
              <Typography level="body-md" color="neutral">
                {selectedTask.description}
              </Typography>
              <Box>
                <Typography level="title-md" sx={{ mb: 1 }}>
                  Details
                </Typography>
                <Stack spacing={1}>
                  <Box>
                    <Typography level="body-sm" color="neutral">
                      Type
                    </Typography>
                    <Typography>{selectedTask.type}</Typography>
                  </Box>
                  <Box>
                    <Typography level="body-sm" color="neutral">
                      Created
                    </Typography>
                    <Typography>{new Date(selectedTask.createdAt).toLocaleString()}</Typography>
                  </Box>
                  <Box>
                    <Typography level="body-sm" color="neutral">
                      Last Updated
                    </Typography>
                    <Typography>{new Date(selectedTask.updatedAt).toLocaleString()}</Typography>
                  </Box>
                </Stack>
              </Box>
            </Box>
          ) : (
            <Box
              sx={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Typography level="body-lg" textAlign="center">
                Select a task to view its details
              </Typography>
            </Box>
          )}
        </Box>

        <ResearchTaskFormModal
          open={formModalOpen}
          onClose={() => {
            setFormModalOpen(false);
          }}
          onTaskCreated={handleTaskCreated} // Auto-select new tasks
          taskId={selectedTaskId}
          researchAgentId={researchAgentId}
        />
      </ModalDialog>
    </Modal>
  );
};

export default ResearchTaskModal;
