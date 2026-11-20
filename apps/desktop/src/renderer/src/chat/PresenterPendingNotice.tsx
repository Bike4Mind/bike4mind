import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import { contentColumnSx } from './layout';

/** Stands in for the held-relay and task-decision trays while Presenter mode is on: a count, never agent text. */
export function PresenterPendingNotice({ count, onTurnOff }: { count: number; onTurnOff: () => void }) {
  if (count === 0) return null;
  return (
    <Box sx={contentColumnSx}>
      <Alert
        size="sm"
        variant="soft"
        sx={{ mt: 1.5 }}
        endDecorator={
          <Button size="sm" variant="soft" onClick={onTurnOff} data-testid="chat-presenter-pending-off-btn">
            Turn off Presenter mode
          </Button>
        }
        data-testid="chat-presenter-pending-notice"
      >
        {count === 1 ? '1 item waiting.' : `${count} items waiting.`} Turn off Presenter mode to review.
      </Alert>
    </Box>
  );
}
