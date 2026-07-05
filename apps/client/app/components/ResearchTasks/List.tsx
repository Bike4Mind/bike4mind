import { FC, useState, useMemo } from 'react';
import { blackAlpha } from '../../utils/themes/colors';
import { Box, Button, List as JoyList, IconButton, LinearProgress } from '@mui/joy';
import { IResearchTask, ResearchTaskStatus, ResearchTaskType } from '@bike4mind/common';
import TaskListItem from './TaskListItem';
import FilterBar from './FilterBar';
import SearchInput from './SearchInput';
import { Add } from '@mui/icons-material';
import ResearchTaskFormModal from './FormModal';

interface ResearchTaskListProps {
  tasks: IResearchTask[];
  isFetching: boolean;
  selectedTaskId?: string;
  onTaskClick: (taskId: string) => void;
  onCreateTask?: () => void;
  researchAgentId: string;
}

const ResearchTaskList: FC<ResearchTaskListProps> = ({
  tasks,
  isFetching,
  selectedTaskId,
  onTaskClick,
  onCreateTask,
  researchAgentId,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [status, setStatus] = useState<ResearchTaskStatus | null>(null);
  const [type, setType] = useState<ResearchTaskType | null>(null);
  const [isFormModalOpen, setIsFormModalOpen] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);

  const filteredTasks = useMemo(() => {
    return tasks.filter(task => {
      const matchesSearch =
        task.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        task.description.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesStatus = !status || task.status === status;
      const matchesType = !type || task.type === type;
      return matchesSearch && matchesStatus && matchesType;
    });
  }, [tasks, searchQuery, status, type]);

  const handleCreateClick = () => {
    setEditingTaskId(null);
    setIsFormModalOpen(true);
    onCreateTask?.();
  };

  const handleEditClick = (taskId: string) => {
    setEditingTaskId(taskId);
    setIsFormModalOpen(true);
  };

  const handleFormModalClose = () => {
    setIsFormModalOpen(false);
    setEditingTaskId(null);
  };

  const handleTaskCreated = (taskId: string) => {
    onTaskClick(taskId);
    console.log(`🎯 Auto-selected newly created research task from list: ${taskId}`);
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <Box sx={{ p: 2, display: 'flex', gap: 2, alignItems: 'center' }}>
        <SearchInput value={searchQuery} onChange={setSearchQuery} />
        <FilterBar status={status} type={type} onStatusChange={setStatus} onTypeChange={setType} />
        <Button
          variant="outlined"
          color="primary"
          onClick={handleCreateClick}
          sx={{
            gap: 1,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          <Add fontSize="small" /> Create Task
        </Button>
      </Box>
      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        {isFetching ? <LinearProgress sx={{ mx: 2 }} /> : null}

        <JoyList
          sx={{
            '--ListItem-radius': '8px',
            '--List-gap': '8px',
            p: 2,
          }}
        >
          {filteredTasks.map(task => (
            <TaskListItem
              key={task.id}
              task={task}
              isSelected={task.id === selectedTaskId}
              onClick={() => onTaskClick(task.id)}
              onEdit={() => handleEditClick(task.id)}
            />
          ))}
        </JoyList>
      </Box>

      {/* Floating Action Button */}
      <IconButton
        variant="solid"
        color="primary"
        onClick={handleCreateClick}
        sx={{
          position: 'absolute',
          bottom: 24,
          right: 24,
          width: 56,
          height: 56,
          borderRadius: '50%',
          boxShadow: `0 4px 20px ${blackAlpha[0][15]}`,
          transition: 'all 0.2s ease-in-out',
          zIndex: 10,
          '&:hover': {
            transform: 'scale(1.1)',
            boxShadow: `0 6px 24px ${blackAlpha[0][20]}`,
          },
          '&:active': {
            transform: 'scale(0.95)',
          },
        }}
      >
        <Add sx={{ fontSize: 28 }} />
      </IconButton>

      <ResearchTaskFormModal
        open={isFormModalOpen}
        onClose={handleFormModalClose}
        onTaskCreated={handleTaskCreated} // Auto-select new tasks
        taskId={editingTaskId || undefined}
        researchAgentId={researchAgentId}
      />
    </Box>
  );
};

export default ResearchTaskList;
