import { useGetQuestMasterPlan } from '@client/app/hooks/data/quests';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import {
  OpenInFull as OpenInViewerIcon,
  AutoAwesome as QuestIcon,
  Extension as SubQuestIcon,
} from '@mui/icons-material';
import { Box, Card, Chip, IconButton, Skeleton, Stack, Tooltip, Typography } from '@mui/joy';
import React, { memo } from 'react';
import QuestExportMenu from './QuestExportMenu';

interface QuestMasterPreviewCardProps {
  onExpand?: () => void;
  questMasterPlanId: string;
}

const QuestMasterPreviewCard: React.FC<QuestMasterPreviewCardProps> = memo(({ onExpand, questMasterPlanId }) => {
  const questMasterPlan = useGetQuestMasterPlan(questMasterPlanId);

  const handleOpenInViewer = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();

    setSessionLayout({
      layout: 'vertical',
      artifactData: {
        type: 'questmaster',
        content: questMasterPlanId,
        mimeType: 'application/x-questmaster',
        id: questMasterPlanId,
      },
      selectedArtifactId: questMasterPlanId,
    });
    onExpand?.();
  };

  if (questMasterPlan.isPending) {
    return <Skeleton variant="text" width="100%" height="40px" />;
  }

  const goal = questMasterPlan?.data?.goal;
  const questCount = questMasterPlan?.data?.quests?.length;

  return (
    <Box sx={{ p: 1, width: '100%' }}>
      <Typography level="body-sm" color="neutral" sx={{ mb: 2 }}>
        Quest plan created with {questMasterPlan?.data?.quests?.length} main tasks and{' '}
        {questMasterPlan?.data?.quests?.reduce((acc, quest) => acc + quest.subQuests?.length, 0)} sub-tasks. Click the
        card below to open in Knowledge Viewer.
      </Typography>

      <Card
        variant="outlined"
        sx={{
          backgroundColor: 'background.level1',
          borderRadius: '8px',
          position: 'relative',
          py: 1,
          px: 2,
          minHeight: 'unset',
          transition: 'all 0.2s ease-in-out',
          cursor: 'pointer',
          '&:hover': {
            backgroundColor: 'background.level2',
            transform: 'translateY(-2px)',
            boxShadow: 'sm',
          },
        }}
        onClick={handleOpenInViewer}
      >
        <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%' }}>
          {/* Quest Icon */}
          <QuestIcon color="primary" sx={{ fontSize: '16px', flexShrink: 0 }} />

          {/* Title */}
          <Typography
            level="title-sm"
            sx={{
              color: 'primary.plainColor',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {goal}
          </Typography>

          {/* Sub-quests Counter */}
          <Tooltip title="Number of steps" placement="top">
            <Chip
              size="sm"
              variant="soft"
              color="neutral"
              startDecorator={<SubQuestIcon sx={{ fontSize: '16px' }} />}
              sx={{
                minWidth: 'unset',
                px: 1,
                flexShrink: 0,
              }}
            >
              {questCount}
            </Chip>
          </Tooltip>

          {/* Export button */}
          {questMasterPlan.data && <QuestExportMenu planId={questMasterPlanId} plan={questMasterPlan.data} size="sm" />}

          {/* Open in Knowledge Viewer button */}
          <Tooltip title="Open in Knowledge Viewer" placement="top">
            <IconButton
              size="sm"
              variant="plain"
              color="primary"
              sx={{
                flexShrink: 0,
                pointerEvents: 'none', // Prevent separate click handling
              }}
            >
              <OpenInViewerIcon />
            </IconButton>
          </Tooltip>
        </Stack>
      </Card>
    </Box>
  );
});

QuestMasterPreviewCard.displayName = 'QuestMasterPreviewCard';

export default QuestMasterPreviewCard;
