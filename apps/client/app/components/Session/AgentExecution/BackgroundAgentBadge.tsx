/**
 * BackgroundAgentBadge - chat-header indicator for in-flight background
 * subagents (`delegate_to_agent({ background: true })`).
 *
 * A background subagent doesn't block the parent agent's iteration loop, so
 * its progress never surfaces inline in `IterationStream`. The badge gives
 * the user an at-a-glance count and a click-to-expand list of who's running.
 *
 * Hidden when the count is 0 - keeps the header clean for the typical
 * non-orchestration session.
 *
 * Pairs with the completion toast fired from `useAgentExecution` when a
 * background child reaches a terminal status.
 */

import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Box, Chip, IconButton, Menu, MenuItem, Stack, Tooltip, Typography } from '@mui/joy';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import {
  useAgentExecutionStore,
  selectActiveBackgroundChildrenForSession,
  type BackgroundChildSummary,
} from '@client/app/stores/useAgentExecutionStore';
import { useAgentExecutionDispatch } from '@client/app/hooks/useAgentExecution';

interface BackgroundAgentBadgeProps {
  sessionId: string | null | undefined;
}

// Map child status -> chip color so the popover scans visually instead of
// requiring the user to read each row's label. Mirrors the convention in
// IterationStream.STATUS_LABEL.
const STATUS_CHIP_COLOR: Record<string, 'neutral' | 'primary' | 'success' | 'warning' | 'danger'> = {
  pending: 'neutral',
  running: 'primary',
  awaiting_permission: 'warning',
  paused: 'warning',
  completed: 'success',
  aborted: 'danger',
  failed: 'danger',
};

const BackgroundAgentBadge: FC<BackgroundAgentBadgeProps> = ({ sessionId }) => {
  // Selector identity must be stable across renders so zustand doesn't re-run
  // the scan on every event - same pattern as ActiveAgentExecutions uses for
  // `selectExecutionIdsForSession`.
  const selector = useMemo(() => selectActiveBackgroundChildrenForSession(sessionId), [sessionId]);
  const background = useAgentExecutionStore(useShallow(selector));

  // Track the anchor via state instead of ref - Joy's Menu re-positions only
  // on prop changes, so reading `ref.current` during render is both unsafe
  // (React 19 rule-of-refs) and unnecessary. The ref-callback form sets state
  // exactly once when the button mounts and clears it on unmount.
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  // Reset popover state when the active count drops to 0 so a follow-up
  // dispatch doesn't auto-open the menu with stale state. `return null` below
  // doesn't unmount the component (it just renders nothing), so without this
  // both `open` and `anchorEl` would persist across runs.
  useEffect(() => {
    if (background.length === 0 && open) setOpen(false);
  }, [background.length, open]);

  if (background.length === 0) return null;

  return (
    <>
      <IconButton
        ref={setAnchorEl}
        data-testid="background-agent-badge"
        size="sm"
        variant="outlined"
        color="primary"
        onClick={() => setOpen(prev => !prev)}
        aria-label={`${background.length} background agent${background.length === 1 ? '' : 's'} running`}
        sx={{ borderRadius: 'xl', px: 1, gap: 0.5, minWidth: 'auto' }}
      >
        <Chip size="sm" color="primary" variant="solid" sx={{ pointerEvents: 'none' }}>
          {background.length}
        </Chip>
        <Typography level="body-xs" sx={{ color: 'inherit', whiteSpace: 'nowrap' }}>
          background agent{background.length === 1 ? '' : 's'}
        </Typography>
      </IconButton>
      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        sx={{ minWidth: 280, maxWidth: 360 }}
      >
        {background.map(entry => (
          <BackgroundChildRow key={entry.child.executionId} entry={entry} />
        ))}
      </Menu>
    </>
  );
};

const BackgroundChildRow: FC<{ entry: BackgroundChildSummary }> = ({ entry }) => {
  const { child } = entry;
  const iterationCount = child.iterations.length;
  // Abort dispatches against the CHILD's execution id (not the parent's) - the
  // background subagent runs in its own Lambda with its own execution row, and
  // the WS handler routes the `abort` command by id. Matches AbortButton's
  // contract: child reaches `aborted` and drops out of the active list, badge
  // count decrements on the next selector run.
  const { abort } = useAgentExecutionDispatch();
  const handleAbort = useCallback(
    (e: React.MouseEvent) => {
      // Stop propagation so the click doesn't also fire the MenuItem's default
      // close-on-select behaviour - the user may want to abort multiple
      // background agents in one popover session.
      e.stopPropagation();
      abort(child.executionId);
    },
    [abort, child.executionId]
  );
  return (
    <MenuItem
      data-testid={`background-agent-row-${child.executionId}`}
      sx={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 0.25 }}
    >
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography level="title-sm" sx={{ flex: 1 }}>
          {child.agentName}
        </Typography>
        <Chip size="sm" variant="soft" color={STATUS_CHIP_COLOR[child.status] ?? 'neutral'}>
          {child.status}
        </Chip>
        <Tooltip title="Stop this background agent" placement="top" disableInteractive>
          <IconButton
            data-testid={`background-agent-abort-${child.executionId}`}
            size="sm"
            variant="plain"
            color="danger"
            onClick={handleAbort}
            aria-label={`Stop background agent ${child.agentName}`}
            sx={{ minWidth: 'auto', p: 0.5 }}
          >
            <StopCircleOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Box>
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
          {iterationCount === 0 ? 'Starting…' : `${iterationCount} iteration${iterationCount === 1 ? '' : 's'}`}
        </Typography>
      </Box>
    </MenuItem>
  );
};

export default BackgroundAgentBadge;
