import { useGetQuestMasterPlan } from '@client/app/hooks/data/quests';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { OpenInFull as OpenInViewerIcon, AutoAwesome as QuestIcon } from '@mui/icons-material';
import { Box, Card, IconButton, Skeleton, Stack, Tooltip, Typography } from '@mui/joy';
import React, { memo } from 'react';
import QuestExportMenu from './QuestExportMenu';
import { actionButtonSx } from '@client/app/components/common/actionButtonSx';

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

  // Card-shaped, not a text bar: the pending state stands in for a card, and a 40px line
  // reads as a reply that lost its content rather than one still loading.
  if (questMasterPlan.isPending) {
    return (
      <Stack spacing={2} sx={{ mt: 3, mb: 1 }}>
        <Skeleton variant="rectangular" width="100%" height="56px" sx={{ borderRadius: '8px' }} />
      </Stack>
    );
  }

  const goal = questMasterPlan?.data?.goal;
  const questCount = questMasterPlan?.data?.quests?.length;

  return (
    <>
      {/* The reply's own body type: this sentence IS the reply, and it used to be set in
          small neutral text that read as a caption on the card below it. */}
      <Typography level="body-md" sx={{ color: 'text.primary' }}>
        Quest plan created with {questMasterPlan?.data?.quests?.length} main tasks and{' '}
        {questMasterPlan?.data?.quests?.reduce((acc, quest) => acc + quest.subQuests?.length, 0)} sub-tasks. Click the
        card below to open in Knowledge Viewer.
      </Typography>

      {/* The rhythm PromptReplies gives artifacts - 24px above, 8px below - rather than the
          card's own outer padding, so a quest plan sits where every other card sits. */}
      <Stack spacing={2} sx={{ mt: 3, mb: 1 }}>
        <Card
          variant="outlined"
          sx={theme => ({
            // background.level1 is not defined by this theme, so this card used to sit on a
            // Joy default that matched no other card in the transcript.
            backgroundColor: theme.palette.reading.cardBase,
            // Same card recipe as the artifact cards and fenced code blocks: the fill
            // stays the theme's own surface, with a brand-blue veil falling across it.
            backgroundImage: `linear-gradient(180deg, ${theme.palette.reading.cardTintTop}, ${theme.palette.reading.cardTintBottom})`,
            borderColor: theme.palette.reading.cardLine,
            borderRadius: '8px',
            position: 'relative',
            transition: 'all 0.2s ease-in-out',
            cursor: 'pointer',
            // Lift and shadow only, as every other card. It also set background.level2 here,
            // which this theme never defines, so hovering flashed a Joy default.
            '&:hover': {
              transform: 'translateY(-2px)',
              boxShadow: 'sm',
            },
          })}
          onClick={handleOpenInViewer}
        >
          {/* 12px throughout, the same rhythm the trailing action group uses. */}
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ width: '100%' }}>
            {/* Sized and coloured like a cited source's icon, so the two lists of framed
                rows a reply can produce carry the same mark. */}
            <QuestIcon sx={{ fontSize: '1.25rem', color: 'text.tertiary', flexShrink: 0 }} />

            {/* Title over its small print, as every other card: the step count was a chip
                out on the right, which is where the actions live on every card but this one. */}
            <Stack sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                level="title-md"
                sx={{
                  color: 'text.primary',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {goal}
              </Typography>
              <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                {questCount} step{questCount === 1 ? '' : 's'}
              </Typography>
            </Stack>

            {/* The trailing action group every artifact card carries, same recipe and same
                12px rhythm. */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
              {questMasterPlan.data && (
                <QuestExportMenu
                  planId={questMasterPlanId}
                  plan={questMasterPlan.data}
                  size="sm"
                  variant="plain"
                  buttonSx={actionButtonSx}
                />
              )}

              <Tooltip title="Open in full viewer" placement="top">
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  sx={actionButtonSx}
                  onClick={handleOpenInViewer}
                  data-testid="questmaster-artifact-expand-btn"
                >
                  <OpenInViewerIcon />
                </IconButton>
              </Tooltip>
            </Box>
          </Stack>
        </Card>
      </Stack>
    </>
  );
});

QuestMasterPreviewCard.displayName = 'QuestMasterPreviewCard';

export default QuestMasterPreviewCard;
