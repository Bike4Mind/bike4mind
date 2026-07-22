/**
 * PermissionCard - inline approval prompt for tools flagged `needs_approval`.
 *
 * Server pauses execution and emits `permission_request`; the store records it
 * on `execution.pendingPermission`. The user picks Approve (one-time),
 * Allow-for-Session, or Deny - each dispatches `permission_response` and
 * optimistically clears `pendingPermission` so the card hides immediately
 * (the server's subsequent `progress`/`iteration_step`/`failed` updates the
 * status authoritatively).
 *
 * Persistence across refresh comes for free: `reconnect_result.pendingPermission`
 * re-hydrates the field on mount.
 */

import { FC, useCallback, useEffect, useMemo, useRef } from 'react';
import { Alert, Box, Button, Stack, Typography } from '@mui/joy';
import { useAgentExecutionStore, selectExecution } from '@client/app/stores/useAgentExecutionStore';
import { useAgentExecutionDispatch } from '@client/app/hooks/useAgentExecution';

interface PermissionCardProps {
  executionId: string;
}

/**
 * Convert a snake_case tool name to a Title Case display label.
 * `delegate_to_agent` -> "Delegate To Agent". Mirrors the same transform
 * applied in `PromptReplies.tsx` for the legacy pending-action card so the
 * two surfaces present tools consistently to the user.
 */
export function humanizeToolName(toolName: string): string {
  return toolName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

function formatToolInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  // Server emits toolInput as a JSON-encoded string. Re-parse and pretty-print
  // so the user can actually read what they're approving; fall back to the raw
  // string if it isn't valid JSON.
  if (typeof input === 'string') {
    try {
      return JSON.stringify(JSON.parse(input), null, 2);
    } catch {
      return input;
    }
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

const PermissionCard: FC<PermissionCardProps> = ({ executionId }) => {
  const pending = useAgentExecutionStore(state => selectExecution(executionId)(state)?.pendingPermission);
  const setPendingPermission = useAgentExecutionStore(s => s.setPendingPermission);
  const setStatus = useAgentExecutionStore(s => s.setStatus);
  const { respondToPermission } = useAgentExecutionDispatch();

  // Guard against double-clicks before the optimistic clear hides the card.
  // Zustand updates are synchronous but React schedules the re-render, so a
  // second click in that gap would dispatch a second permission_response over
  // the WS - the server matches by toolName but doesn't enforce response
  // idempotency, and two conflicting clicks (e.g. Allow + Deny back-to-back)
  // could put the executor in an unexpected state.
  //
  // The card doesn't unmount between iterations - the parent execution stays
  // mounted and only `pending` toggles undefined -> set as each iteration's
  // permission arrives. So the guard must be reset per permission instance,
  // keyed on `requestedAt` (unique per server request). Without this, the
  // guard latches `true` after iteration 1 and silently swallows every click
  // on iteration 2+.
  const responding = useRef(false);

  // Reset the guard whenever a new permission instance arrives. Effects run
  // after render but before the user can click, so the guard is always clean
  // for the freshly-rendered card.
  useEffect(() => {
    responding.current = false;
  }, [pending?.requestedAt]);

  const handleRespond = useCallback(
    (approved: boolean, rememberForSession: boolean, toolName: string) => {
      if (responding.current) return;
      responding.current = true;
      respondToPermission(executionId, toolName, approved, rememberForSession);
      // Optimistic clear so the card hides immediately; the server's next
      // event will reconcile the real status (running on approve, failed on deny).
      setPendingPermission(executionId, undefined);
      // On approve, optimistically transition the execution back to `running`
      // so the IterationStream's chip-level spinner + "Thinking..." placeholder
      // render during the few seconds between the WS permission_response and
      // the server's next `progress` / `iteration_step` event. Without this,
      // status stays `awaiting_permission` after the card unmounts and the
      // user sees a silent gap that looks like the run died. We leave status
      // alone on deny - the run is about to transition to `failed` server-side
      // and forcing `running` first would briefly mis-indicate progress.
      if (approved) {
        setStatus(executionId, 'running');
      }
    },
    [executionId, respondToPermission, setPendingPermission, setStatus]
  );

  const formattedInput = useMemo(() => formatToolInput(pending?.toolInput), [pending?.toolInput]);

  if (!pending) return null;

  const toolDisplayName = humanizeToolName(pending.toolName);

  // Match the outlined action buttons below chat messages: neutral outline on an
  // opaque chat-area (background.body) fill, so the buttons read as buttons
  // instead of blending into the warning Alert (the neutral border is invisible
  // on the warm Alert tint but shows on the darker chat bg).
  //
  // Joy's outlined rest background does not come from --variant-outlinedBg here
  // (setting it had no effect), so set the actual background-color property with
  // !important to beat Joy's own declaration. Hover lifts to surface2 (also
  // !important). Border stays the neutral --variant-outlinedBorder; Deny's red
  // text is handled separately via --variant-outlinedColor.
  const outlinedActionSx = {
    borderRadius: '6px',
    backgroundColor: 'var(--joy-palette-background-body) !important',
    '&:hover': { backgroundColor: 'var(--joy-palette-background-surface2) !important' },
  };

  return (
    <Alert
      data-testid={`permission-card-${executionId}`}
      color="warning"
      variant="soft"
      sx={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 2, mt: 1, p: 2 }}
    >
      <Typography level="title-sm" sx={{ color: 'text.primary', fontSize: '16px' }}>
        Allow <strong>{toolDisplayName}</strong> at iteration {pending.iteration + 1}?
      </Typography>
      {formattedInput ? (
        <Box
          component="pre"
          sx={{
            m: 0,
            p: 1,
            borderRadius: 'sm',
            // Match the outer IterationStream frame so the code block reads as a
            // distinct surface sitting on top of the orange (both light + dark).
            backgroundColor: 'background.surface2',
            color: 'text.primary',
            fontSize: 'xs',
            maxHeight: 160,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {formattedInput}
        </Box>
      ) : null}
      <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap' }}>
        <Button
          data-testid={`permission-approve-${executionId}`}
          color="success"
          size="sm"
          onClick={() => handleRespond(true, false, pending.toolName)}
        >
          Approve
        </Button>
        <Button
          data-testid={`permission-allow-session-${executionId}`}
          variant="outlined"
          color="neutral"
          size="sm"
          sx={outlinedActionSx}
          onClick={() => handleRespond(true, true, pending.toolName)}
        >
          Allow for Session
        </Button>
        <Button
          data-testid={`permission-deny-${executionId}`}
          variant="outlined"
          color="neutral"
          size="sm"
          // Same outlined frame/fill as Allow, but red text/icon to signal the
          // reject action. Overriding --variant-outlinedColor (not color="danger")
          // keeps the border and hover neutral.
          sx={{ ...outlinedActionSx, '--variant-outlinedColor': 'var(--joy-palette-danger-outlinedColor)' }}
          onClick={() => handleRespond(false, false, pending.toolName)}
        >
          Deny
        </Button>
      </Stack>
    </Alert>
  );
};

export default PermissionCard;
