import { Box, CircularProgress, Typography } from '@mui/joy';
import { AutoAwesome as QuestIcon } from '@mui/icons-material';
import { useQuestPreparation } from '@client/app/hooks/useQuestPreparation';

/**
 * Global overlay shown when preparing a quest from the /quests page.
 * This component should be rendered at the app level (e.g., in root layout)
 * so it persists across page navigation.
 */
export function QuestPreparationOverlay() {
  const { isPreparingQuest, questGoal } = useQuestPreparation();

  if (!isPreparingQuest || !questGoal) {
    return null;
  }

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.surface',
        gap: 3,
        p: 4,
      }}
    >
      <Box sx={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <CircularProgress size="lg" />
        <QuestIcon
          sx={{
            position: 'absolute',
            fontSize: 24,
            color: 'primary.500',
          }}
        />
      </Box>
      <Typography level="h3" sx={{ textAlign: 'center' }}>
        Preparing your quest...
      </Typography>
      <Box
        sx={{
          maxWidth: 600,
          p: 2,
          borderRadius: 'md',
          bgcolor: 'background.level1',
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Typography level="body-md" sx={{ textAlign: 'center', fontStyle: 'italic' }}>
          &ldquo;{questGoal}&rdquo;
        </Typography>
      </Box>
      <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
        Setting up your notebook and creating quest plan...
      </Typography>
    </Box>
  );
}
