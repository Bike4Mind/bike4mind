import { IResearchTask, ResearchTaskStatus } from '@bike4mind/common';
import { brandAlpha, purpleAlpha, brand, purple } from '../../../utils/themes/colors';
import { useResearchTaskWebSocket } from '@client/app/hooks/data/researchTasks';
import { Box, Chip, CircularProgress, LinearProgress, Typography } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import { FC, useEffect } from 'react';
interface LiveStatusProps {
  task: IResearchTask;
}

const ResearchTaskDetailLiveStatus: FC<LiveStatusProps> = ({ task }) => {
  const queryClient = useQueryClient();
  const liveStatus = useResearchTaskWebSocket(task?.id);
  const progress = liveStatus?.progress || 0;
  const currentStep = liveStatus?.currentStep || '⏳ Checking progress...';
  // Listen to task progress changes
  useEffect(() => {
    console.log('📊 [DEBUG] Live status:', liveStatus?.progress);
    if (!liveStatus?.progress) return;
    if (liveStatus.progress === 100) {
      console.log('🔄 [WEBSOCKET] Task completed, invalidating queries');
      // Invalidate the task list for this agent
      queryClient.invalidateQueries({
        queryKey: ['research-tasks', 'list', { agentId: task.researchAgentId }],
      });
    }
  }, [liveStatus?.progress, task.id, task.researchAgentId, queryClient]);

  if (task.status === ResearchTaskStatus.COMPLETED || task.status === ResearchTaskStatus.FAILED) {
    return null;
  }

  return (
    <Box
      sx={{
        mt: 2,
        p: 3,
        bgcolor: 'primary.50',
        borderRadius: '12px',
        border: '1px solid',
        borderColor: 'primary.200',
        background: `linear-gradient(135deg, ${brandAlpha[500][8]} 0%, ${purpleAlpha[550][8]} 100%)`,
        boxShadow: `0 4px 12px ${brandAlpha[500][10]}`,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
        <CircularProgress
          size="md"
          color="primary"
          sx={{
            '--CircularProgress-size': '32px',
            animation: 'pulse 2s infinite',
            '@keyframes pulse': {
              '0%, 100%': { opacity: 1 },
              '50%': { opacity: 0.7 },
            },
          }}
        />
        <Box sx={{ flex: 1 }}>
          <Typography level="title-md" sx={{ color: 'primary.700', fontWeight: 700, mb: 0.5 }}>
            🚀 Live Research Progress
          </Typography>
          <Typography
            level="body-md"
            sx={{
              color: 'primary.600',
              fontWeight: 500,
              fontSize: '14px',
            }}
          >
            {currentStep}
          </Typography>
        </Box>
        <Chip
          variant="soft"
          color="primary"
          size="sm"
          sx={{
            fontWeight: 600,
            fontSize: '12px',
            minWidth: '60px',
          }}
        >
          {progress}%
        </Chip>
      </Box>
      <LinearProgress
        determinate
        thickness={8}
        value={progress}
        sx={{
          bgcolor: 'primary.100',
          borderRadius: '4px',
          '&::before': {
            background: `linear-gradient(90deg, ${brand[500]} 0%, ${purple[500]} 100%)`,
          },
        }}
      />
    </Box>
  );
};

export default ResearchTaskDetailLiveStatus;
