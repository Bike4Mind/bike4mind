import { Box, Grid, Option, Select, Typography } from '@mui/joy';
import { isPromptCacheTtl } from '@bike4mind/common';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import { cardSurfaceSx } from '@client/app/components/ProfileModal/settingsStyles';

/** Default prompt-cache lifetime for new chats; each chat can still pick its own in the composer. */
export default function PromptCacheDefaultCard() {
  const { settings, updatePreferences } = useUserSettings();

  return (
    <Grid xs={12} md={6}>
      <Box
        data-testid="settings-prompt-cache-card"
        sx={theme => ({
          ...cardSurfaceSx(theme),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
          height: '100%',
        })}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-md" sx={{ fontSize: '16px', fontWeight: 500 }}>
            Prompt Cache
          </Typography>
          <Typography level="body-sm" sx={{ mt: 0.5 }}>
            How long Claude keeps a chat cached between messages. An hour costs more to cache (2x input instead of
            1.25x) and the same to reuse.
          </Typography>
        </Box>
        <Select
          data-testid="settings-prompt-cache-select"
          value={settings.promptCacheTtl}
          onChange={(_, value) => {
            if (isPromptCacheTtl(value)) updatePreferences({ promptCacheTtl: value });
          }}
          size="md"
          sx={{ minWidth: '140px' }}
        >
          <Option value="5m" data-testid="settings-prompt-cache-option-5m">
            5 minutes
          </Option>
          <Option value="1h" data-testid="settings-prompt-cache-option-1h">
            1 hour
          </Option>
        </Select>
      </Box>
    </Grid>
  );
}
