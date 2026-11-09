import { useEffect, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import type { LoopState } from '@shared/loop';
import { contentColumnSx } from './layout';

export function LoopBar({ sessionId }: { sessionId: string | null }) {
  const [state, setState] = useState<LoopState | null>(null);
  useEffect(() => {
    setState(null);
    if (!sessionId || !window.b4m.chat.getLoop) return;
    let live = true;
    let pushed = false;
    const unsubscribe = window.b4m.chat.onLoopChanged(event => {
      if (event.sessionId !== sessionId) return;
      pushed = true;
      setState(event.state);
    });
    void window.b4m.chat
      .getLoop(sessionId)
      .then(value => {
        if (live && !pushed) setState(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [sessionId]);
  if (!state || state.sessionId !== sessionId) return null;
  const cadence = state.intervalMs === null ? 'Model-paced' : `${state.intervalMs / 1000}s after completion`;
  const next = state.nextRunAt === null ? state.phase : `Next: ${new Date(state.nextRunAt).toLocaleTimeString()}`;
  return (
    <Alert
      role="status"
      color={state.phase === 'paused' ? 'warning' : 'neutral'}
      variant="soft"
      size="sm"
      sx={{ ...contentColumnSx, mt: 1 }}
      data-testid="loop-status"
      endDecorator={
        <Button
          size="sm"
          variant="soft"
          color="neutral"
          data-testid="loop-stop-btn"
          onClick={() => void window.b4m.chat.loopCommand(state.sessionId, 'stop')}
        >
          Stop loop
        </Button>
      }
    >
      <Typography level="body-xs">
        Loop: {state.prompt} - {cadence}. {next}. {state.error ?? 'This app run only. Stop loop cancels future runs.'}
      </Typography>
    </Alert>
  );
}
