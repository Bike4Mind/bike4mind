import { useEffect, useState } from 'react';
import { Box, Button, DialogTitle, Modal, ModalClose, ModalDialog, Typography } from '@mui/joy';
import type { PrActionResult, PrBarState } from '@shared/pullRequest';
import { PrStatusBar } from '../PrStatusBar';
import type { BuiltInBrowserOpener } from '../prLinks';

export function AgentPrDialog({
  sessionId,
  title,
  onClose,
  onOpenLink,
}: {
  sessionId: string;
  title: string;
  onClose(): void;
  onOpenLink?: BuiltInBrowserOpener;
}) {
  const [state, setState] = useState<PrBarState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    let revision = 0;
    let reading = false;
    const unsubscribe = window.b4m.pullRequests.onStateChanged(next => {
      if (!live || next.sessionId !== sessionId) return;
      revision += 1;
      setState(next);
      setLoaded(true);
      setError(null);
    });
    // The root owns watch(); this selected-session read must never replace its watch slot.
    const read = () => {
      if (reading) return;
      reading = true;
      const startedAt = revision;
      void window.b4m.pullRequests
        .getState(sessionId)
        .then(initial => {
          if (!live) return;
          if (revision === startedAt) setState(initial);
          setLoaded(true);
          setError(null);
        })
        .catch(caught => {
          if (live && revision === startedAt) setError(caught instanceof Error ? caught.message : String(caught));
        })
        .finally(() => {
          reading = false;
        });
    };
    read();
    const timer = window.setInterval(read, 30_000);
    return () => {
      live = false;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [sessionId, attempt]);

  const action = async (run: () => Promise<PrActionResult>): Promise<PrActionResult> => {
    try {
      return await run();
    } catch (caught) {
      return { ok: false, error: caught instanceof Error ? caught.message : String(caught) };
    }
  };
  const visible = state?.binding && !state.binding.dismissed;
  return (
    <Modal open onClose={onClose} disableEnforceFocus sx={{ zIndex: 'popup' }}>
      <ModalDialog
        aria-labelledby="agent-pr-title"
        data-testid="orchestrator-pr-dialog"
        sx={{ width: 440, maxWidth: 'calc(100vw - 32px)' }}
      >
        <ModalClose data-testid="orchestrator-pr-close" />
        <DialogTitle id="agent-pr-title" sx={{ pr: 3 }}>
          Pull request
        </DialogTitle>
        <Typography level="body-sm" textColor="text.secondary" noWrap>
          {title}
        </Typography>
        {refreshError && (
          <Typography level="body-sm" color="danger" role="alert">
            {refreshError}
          </Typography>
        )}
        {error ? (
          <Box>
            <Typography level="body-sm" color="danger" role="alert">
              {error}
            </Typography>
            <Button data-testid="orchestrator-pr-retry" onClick={() => setAttempt(value => value + 1)}>
              Retry
            </Button>
          </Box>
        ) : !loaded ? (
          <Typography role="status" level="body-sm">
            Reading pull request...
          </Typography>
        ) : !visible ? (
          <Typography role="status" level="body-sm">
            No pull request is linked to this agent.
          </Typography>
        ) : (
          <PrStatusBar
            state={state}
            onDismiss={() =>
              action(() => window.b4m.pullRequests.dismiss(sessionId)).then(result => {
                if (result.ok) onClose();
                return result;
              })
            }
            onRefresh={() => {
              setRefreshError(null);
              void action(async () => {
                await window.b4m.pullRequests.refresh(sessionId);
                return { ok: true };
              }).then(result => setRefreshError(result.ok ? null : result.error));
            }}
            onSetOption={(option, enabled) =>
              action(() => window.b4m.pullRequests.setOption(sessionId, option, enabled))
            }
            onOpenLink={onOpenLink}
          />
        )}
      </ModalDialog>
    </Modal>
  );
}
