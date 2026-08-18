/**
 * ReasoningDisclosure - collapsible "Show reasoning" panel rendered under a
 * Quest reply bubble when that Quest was created from an agent_execute run.
 *
 * Live runs render the iteration trace inline via `ActiveAgentExecutions`
 * -> `IterationStream`. Once a run completes, that live mount unmounts (the
 * Quest takes over) and the iteration trace is lost from the in-memory
 * Zustand store the next time the user refreshes. This disclosure lazy-loads
 * the persisted trace from `/api/agent-executions/[id]` and mounts the same
 * `IterationStream` component against it.
 *
 * Hydration trick: instead of forking IterationStream into a "read-only"
 * variant, we hydrate the fetched trace into the same Zustand store under
 * a `replay-<executionId>` synthetic id, then mount `IterationStream` with
 * that id. The store entry has `status: 'completed'`, no pendingPermission,
 * and is unaffected by the live execution flow - so existing rendering
 * logic (filter terminal status, hide credits, etc.) works unchanged. The
 * one place that would misbehave is the parent's `ActiveAgentExecutions`
 * filter - but the replay id is never in that selector's session, so it's
 * inert there.
 */

import { FC, useEffect, useState } from 'react';
import { Box, Button, CircularProgress, Divider, Stack, Typography } from '@mui/joy';
import { keyframes } from '@mui/system';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';
import type { AgentExecutionChildSnapshot } from '@client/app/hooks/data/agentExecutions';
import { useAgentExecutionTrace } from '@client/app/hooks/data/agentExecutions';
import {
  useAgentExecutionStore,
  type ChildExecution,
  type IterationStep,
} from '@client/app/stores/useAgentExecutionStore';
import IterationStream from './IterationStream';

// Entrance animation for the expanded trace frame - a quick fade + slight
// slide-down so the reasoning reveals rather than snapping into place.
const revealIn = keyframes`
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
`;

// Recursively converts a server ChildExecutionSnapshot tree into the store's
// ChildExecution map shape. Module-level so it can self-reference.
function buildChildMap(children: AgentExecutionChildSnapshot[] | undefined): Record<string, ChildExecution> {
  const map: Record<string, ChildExecution> = {};
  if (!children) return map;
  for (const child of children) {
    const iterations: IterationStep[] = child.steps.map((step, idx) => ({
      iteration: (step.metadata as { iteration?: number } | undefined)?.iteration ?? idx,
      step,
      isComplete: true,
      receivedAt: Date.now() + idx,
    }));
    map[child.executionId] = {
      executionId: child.executionId,
      agentName: child.agentName,
      model: child.model,
      status: child.status,
      iterations,
      totalCredits: child.totalCredits,
      finalAnswer: child.finalAnswer,
      error: child.error,
      isTimeout: child.isTimeout,
      isBackground: false,
      childExecutions: buildChildMap(child.children),
    };
  }
  return map;
}

interface ReasoningDisclosureProps {
  /** The originating AgentExecution id, from `Quest.agentExecutionId`. */
  agentExecutionId: string;
  /** Session the parent Quest belongs to - used as the synthetic replay sessionId. */
  sessionId: string;
  /**
   * Start expanded. Used by the `/agent-executions?expand=<id>` deep-link
   * so the "View trace" toast launcher lands on an already-open trace.
   */
  defaultExpanded?: boolean;
  /**
   * Render the run's final answer inside the trace. Defaults to `false` for the
   * Quest-bubble context, where the reply above already shows the answer (and
   * duplicating it would be redundant). The standalone `/agent-executions` focused
   * panel has no other answer surface (the toast preview is truncated), so
   * it sets this `true`; otherwise a final-answer-only run would render an empty
   * "No reasoning steps recorded" panel with no result at all.
   */
  showFinalAnswer?: boolean;
}

const ReasoningDisclosure: FC<ReasoningDisclosureProps> = ({
  agentExecutionId,
  sessionId,
  defaultExpanded = false,
  showFinalAnswer = false,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { data, isLoading, isError } = useAgentExecutionTrace(agentExecutionId, expanded);

  // Synthetic execution id for the replay so it never collides with a live run.
  const replayId = `replay-${agentExecutionId}`;

  // Hydrate the trace into the store on first successful fetch. Idempotent: the
  // effect deps include `data`, and React Query can hand back a new `data`
  // reference on a background refetch (tab refocus). Re-running would re-append
  // parent iterations and re-seed children, doubling the trace - so bail once
  // this replay entry has been hydrated to its terminal `completed` state.
  useEffect(() => {
    if (!expanded || !data) return;
    const store = useAgentExecutionStore.getState();
    if (store.executions[replayId]?.status === 'completed') return;
    // Start fresh for the first hydration of this id.
    store.startExecution(replayId, sessionId);
    // Append each step as an iteration entry. IterationStream groups by
    // the `iteration` index; backend persists steps in arrival order with
    // an `iteration` number on each. Fall back to sequential numbering if
    // missing (legacy data).
    data.steps.forEach((step, idx) => {
      const iteration = (step.metadata as { iteration?: number } | undefined)?.iteration ?? idx;
      store.appendIteration(replayId, {
        iteration,
        step,
        isComplete: true,
        // Offset by idx so steps within the same iteration get distinct
        // timestamps: stepToChildId keys on `${iteration}-${receivedAt}`,
        // and a tight synchronous loop can assign the same millisecond to
        // multiple steps, causing every step to match the child.
        receivedAt: Date.now() + idx,
      });
    });
    // Subagent replay. Build the child map directly and replace it
    // wholesale (mirroring the WS reconnect path's `buildChildren`) rather than
    // imperatively start/complete/fail each child. This preserves the child's
    // *real* terminal status: `aborted` and `timed_out` no longer collapse to
    // `failed` (the old `failChild` path hardcoded `'failed'`), and non-terminal
    // statuses are carried through verbatim instead of being left as `'running'`.
    // Insertion order matches the server's creation order, which
    // `IterationStream`'s delegate-action to child ordinal mapping relies on.
    if (data.children) {
      store.setChildExecutions(replayId, buildChildMap(data.children));
    }
    // Final state: completed with the persisted answer.
    store.markCompleted(replayId, data.answer ?? undefined, 0);
  }, [expanded, data, replayId, sessionId]);

  // No explicit eviction - the synthetic replay entry sits in the in-memory
  // store under a unique `replay-<id>` key. It costs ~kb per expand and a
  // page refresh clears it. Adding a focused per-execution evictor would be
  // a small follow-up if the store ever holds many replays at once.

  const toggle = (
    <Button
      size="sm"
      variant="plain"
      color="neutral"
      startDecorator={<PsychologyOutlinedIcon fontSize="small" />}
      endDecorator={expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
      onClick={() => setExpanded(v => !v)}
      sx={{
        '--Button-gap': '0.4rem',
        fontWeight: 400,
        fontSize: '13px',
        color: 'text.primary', // label
        '& .MuiButton-startDecorator svg': { color: 'text.tertiary', fontSize: '18px' }, // brain icon
        '& .MuiButton-endDecorator svg': { color: 'text.tertiary', fontSize: '18px' }, // chevron (default)
        '&:hover .MuiButton-endDecorator svg': { color: 'text.primary' }, // chevron on hover
        // No background hover - the only hover cue is the chevron color change
        // above. Pin the plain-variant hover/active bg to each state's rest bg so
        // Joy's default gray hover doesn't sneak in. Collapsed: the button IS the
        // framed card (surface2 + outlined border + 8px radius, 12/16 padding),
        // sized to content, whole card clickable. Expanded: bare full-width header.
        ...(expanded
          ? {
              '--Button-paddingInline': '0px',
              p: 0,
              minHeight: '24px',
              width: '100%',
              justifyContent: 'flex-start',
              '--variant-plainHoverBg': 'transparent',
              '--variant-plainActiveBg': 'transparent',
            }
          : {
              width: 'fit-content',
              minHeight: 0,
              py: 1.5, // 12px top/bottom
              px: 2, // 16px sides
              border: '1px solid',
              borderColor: 'neutral.outlinedBorder',
              borderRadius: '8px',
              backgroundColor: 'background.surface2',
              '--variant-plainHoverBg': 'var(--joy-palette-background-surface2)',
              '--variant-plainActiveBg': 'var(--joy-palette-background-surface2)',
            }),
      }}
    >
      {expanded ? 'Hide reasoning' : 'Show reasoning'}
    </Button>
  );

  return (
    <Box data-testid={`reasoning-disclosure-${agentExecutionId}`}>
      {expanded ? (
        // Expanded: one frame (matching the iteration-stream frame) with the
        // "Hide reasoning" header on top, then the trace rendered unframed inside
        // it so the border isn't doubled.
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 1.5, // 12px: header -> divider -> content
            pt: 1.5, // 12px top
            px: 2, // 16px sides
            pb: 2, // 16px bottom
            border: '1px solid',
            borderColor: 'neutral.outlinedBorder',
            backgroundColor: 'background.surface2',
            borderRadius: '8px',
            animation: `${revealIn} 0.2s ease`,
          }}
        >
          {toggle}
          {/* Full-width separator: negative horizontal margin cancels the frame's
              16px side padding so the line runs edge to edge. */}
          <Divider sx={{ mx: -2 }} />
          {isLoading ? (
            <Stack direction="row" alignItems="center" spacing={1}>
              <CircularProgress size="sm" thickness={2} />
              <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
                Loading reasoning trace…
              </Typography>
            </Stack>
          ) : isError ? (
            <Typography level="body-sm" sx={{ color: 'danger.softColor' }}>
              Couldn&apos;t load the reasoning trace. The execution may be older than its retention window.
            </Typography>
          ) : data && !showFinalAnswer && !data.steps.some(s => s.type !== 'final_answer') ? (
            // Only treat a final-answer-only run as "empty" when we're ALSO hiding
            // the answer (Quest-bubble context: the answer is in the reply above).
            <Typography level="body-sm" sx={{ color: 'text.tertiary', fontStyle: 'italic' }}>
              No reasoning steps recorded for this run.
            </Typography>
          ) : data ? (
            // hideFinalAnswer (default): the reply bubble above already shows the
            // final answer; collapsedByDefault: iterations start collapsed;
            // unframed: this disclosure supplies the frame (above).
            <IterationStream executionId={replayId} hideFinalAnswer={!showFinalAnswer} collapsedByDefault unframed />
          ) : null}
        </Box>
      ) : (
        toggle
      )}
    </Box>
  );
};

export default ReasoningDisclosure;
