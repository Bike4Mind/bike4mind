import { useState } from 'react';
import Button from '@mui/joy/Button';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { LOCAL_HISTORY_CHANGED } from './localHistory';

export function LocalHistorySettings() {
  const [clearing, setClearing] = useState(false);
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);
  const clear = async () => {
    setClearing(true);
    setStatus(null);
    try {
      await window.b4m.chat.clearHistory();
      window.dispatchEvent(new Event(LOCAL_HISTORY_CHANGED));
      setStatus({ error: false, text: 'Local search history cleared.' });
    } catch (error) {
      setStatus({
        error: true,
        text: `Could not clear local history. ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setClearing(false);
    }
  };
  return (
    <Stack spacing={1}>
      <Button
        size="sm"
        color="danger"
        variant="soft"
        loading={clearing}
        onClick={() => void clear()}
        data-testid="settings-clear-history-btn"
      >
        Clear local history
      </Button>
      {status && (
        <Typography level="body-xs" role={status.error ? 'alert' : 'status'} data-testid="settings-history-status">
          {status.text}
        </Typography>
      )}
    </Stack>
  );
}
