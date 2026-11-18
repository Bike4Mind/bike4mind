import { Alert, Box, Button, Typography } from '@mui/joy';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { useQuestMasterUpgrade } from '@client/app/components/subscription/questMasterUpgrade';

interface FreeQuestLimitNoticeProps {
  /** Server-authored reply explaining the free quest limit. */
  message: string;
}

/** Notice shown when a queued Questmaster start settles with `free_quest_limit_reached`. */
export const FreeQuestLimitNotice = ({ message }: FreeQuestLimitNoticeProps) => {
  return (
    <Alert
      data-testid="free-quest-limit-notice"
      variant="soft"
      color="warning"
      startDecorator={<WarningAmberRoundedIcon />}
      sx={{ alignItems: 'center', gap: 1.5, p: '16px' }}
    >
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1.5,
          width: '100%',
        }}
      >
        <Typography
          level="body-sm"
          textColor="text.secondary"
          sx={{ flex: 1, minWidth: '240px' }}
          data-testid="free-quest-limit-message"
        >
          {message}
        </Typography>
        <Box sx={{ flexShrink: 0 }}>
          <Button
            size="sm"
            onClick={() => useQuestMasterUpgrade.getState().open()}
            data-testid="free-quest-limit-options-btn"
          >
            See options
          </Button>
        </Box>
      </Box>
    </Alert>
  );
};
