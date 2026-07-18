/**
 * IterationStream - collapsible per-iteration container.
 *
 * Groups consecutive `iteration_step` events under one "Iteration N"
 * header. Once the execution reaches a terminal state, surfaces the
 * outcome (final answer / aborted / failed) below the stream.
 */

import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionGroup,
  AccordionSummary,
  Box,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from '@mui/joy';
import {
  useAgentExecutionStore,
  selectExecution,
  isActiveStatus,
  type IterationStep as IterationStepData,
} from '@client/app/stores/useAgentExecutionStore';
import IterationStep from './IterationStep';
import AbortButton from './AbortButton';
import PermissionCard from './PermissionCard';
import SubagentStepNest from './SubagentStepNest';
import { copyForRunningTool, THINKING_COPY } from './loadingCopy';
import { useRotatingCopy } from './useRotatingCopy';

interface IterationStreamProps {
  executionId: string;
  /**
   * When mounted inside the chat-history "Show reasoning" disclosure, the
   * Quest reply bubble already shows the final answer prominently above -
   * rendering it again in the trailing green box duplicates content for
   * short answers and forces the user to scroll past the same paragraphs
   * twice for long ones. The live `ActiveAgentExecutions` mount keeps the
   * default (`false`) since there's no reply bubble yet.
   */
  hideFinalAnswer?: boolean;
  /**
   * Force every iteration accordion open by default. The live mount relies
   * on the natural `defaultExpanded={isLast}` behavior (each iteration mounts
   * as "the latest" at the time, then stays uncontrolled-open as the next
   * one arrives), but the disclosure replay hydrates all iterations at once,
   * so without this flag only the last one mounts expanded. The user
   * expanding "Show reasoning" wants the full trace visible - they
   * shouldn't have to click each step to see the work.
   */
  expandAll?: boolean;
}

interface IterationGroup {
  iteration: number;
  steps: IterationStepData[];
}

export function groupByIteration(items: IterationStepData[]): IterationGroup[] {
  const map = new Map<number, IterationStepData[]>();
  for (const item of items) {
    const existing = map.get(item.iteration);
    if (existing) {
      existing.push(item);
    } else {
      map.set(item.iteration, [item]);
    }
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a - b)
    .map(([iteration, steps]) => ({ iteration, steps }));
}

const STATUS_LABEL: Record<string, { label: string; color: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' }> =
  {
    pending: { label: 'Starting…', color: 'neutral' },
    running: { label: 'Running', color: 'primary' },
    awaiting_permission: { label: 'Awaiting permission', color: 'warning' },
    paused: { label: 'Paused', color: 'warning' },
    completed: { label: 'Completed', color: 'success' },
    aborted: { label: 'Aborted', color: 'danger' },
    failed: { label: 'Failed', color: 'danger' },
  };

const IterationStream: FC<IterationStreamProps> = ({ executionId, hideFinalAnswer = false, expandAll = false }) => {
  const execution = useAgentExecutionStore(selectExecution(executionId));

  // Per-iteration manual override of the default "expanded only if latest"
  // rule. `undefined` means "follow the default"; a boolean means the user
  // clicked the summary and we should respect their choice across re-renders
  // (e.g. when a new iteration arrives and shifts which one counts as latest).
  // Stored as a plain Map kept in a ref-like state - value-identity changes on
  // every set so React re-renders, but we don't recreate the Map for read-only
  // lookups.
  const [overrides, setOverrides] = useState<Map<number, boolean>>(() => new Map());
  const toggleIteration = useCallback((iter: number, expanded: boolean) => {
    setOverrides(prev => {
      const next = new Map(prev);
      next.set(iter, expanded);
      return next;
    });
  }, []);

  const groups = useMemo(() => groupByIteration(execution?.iterations ?? []), [execution?.iterations]);

  // Count of iteration groups that actually have visible (non-final_answer)
  // steps. For a trivial run that produced only a final_answer step, all
  // groups would be filtered out at render time and the header's
  // "1 iteration" would be misleading (the user saw no iterations rendered).
  // Computed before the early return below so the hook order stays stable.
  const visibleIterationCount = useMemo(
    () => groups.filter(g => g.steps.some(s => s.step.type !== 'final_answer')).length,
    [groups]
  );

  // Map each `delegate_to_agent` action step to its corresponding non-background
  // child execution by ordinal position. The server emits `subagent_started`
  // events in the same order the parent's `delegate_to_agent` actions fire,
  // and our WS subscriber preserves that order - so the Nth action step maps
  // to the Nth child by store-insertion order. Background children are
  // skipped at render time (they surface via the header badge instead
  // of inline nesting), but they must still advance the cursor so a
  // foreground delegate following a background one maps to the correct child.
  //
  // Recomputed only when iterations or child set change - cheap; both
  // collections are small (typically <20 items combined).
  const stepToChildId = useMemo(() => {
    const allChildren = Object.values(execution?.childExecutions ?? {});
    const map = new Map<string, string>(); // key: `${iteration}-${receivedAt}`, value: childExecutionId
    let cursor = 0;
    for (const item of execution?.iterations ?? []) {
      const isDelegate = item.step.type === 'action' && item.step.metadata?.toolName === 'delegate_to_agent';
      if (!isDelegate) continue;
      const child = allChildren[cursor];
      if (!child) {
        // During an ACTIVE run a `delegate_to_agent` action step can be recorded
        // before its `subagent_started` child event arrives - an expected,
        // transient ordering gap (this memo recomputes when the child lands, so
        // the mapping self-heals). Only treat it as the alarm-bell once the run
        // is TERMINAL and still misaligned: that means the WS-ordering invariant
        // genuinely broke (multi-tab multiplex, server-side reorder, fan-in from
        // queue dispatch) rather than a race we'll recover from. Logging on every
        // active-run render was just noise during background delegations.
        // Use the canonical active-status set, not a hand-rolled pending/running
        // check - delegation-in-flight states (awaiting_subagent, awaiting_dag_children)
        // are exactly when this race happens and must count as active.
        const isActiveRun = execution ? isActiveStatus(execution.status) : false;
        if (!isActiveRun) {
          console.warn('[IterationStream] delegate action without matching child — ordinal mapping out of sync', {
            executionId,
            iteration: item.iteration,
            cursor,
            childCount: allChildren.length,
          });
        }
        break;
      }
      cursor += 1;
      // Skip background children - they don't render inline. But the cursor
      // has already advanced so the next foreground delegate pairs with its
      // own child (not the background one's slot).
      if (child.isBackground) continue;
      map.set(`${item.iteration}-${item.receivedAt}`, child.executionId);
    }
    return map;
    // `execution?.status` is a dep: the warn gating reads it (via isActiveStatus), and a
    // terminal transition (e.g. markCompleted) can flip status while leaving
    // iterations/childExecutions unchanged - without it the memo wouldn't recompute and
    // the gating would evaluate a stale status.
  }, [execution?.iterations, execution?.childExecutions, execution?.status, executionId]);

  if (!execution) {
    return null;
  }

  const statusMeta = STATUS_LABEL[execution.status] ?? { label: execution.status, color: 'neutral' as const };
  const lastIteration = groups[groups.length - 1]?.iteration ?? 0;

  // Active = the executor is doing work right now. We surface a live
  // spinner/working indicator in two places (next to the status chip and
  // under the latest iteration) so the UI doesn't read as "stuck" during
  // the gap between a tool dispatch and the observation event.
  const isActive = execution.status === 'pending' || execution.status === 'running';
  const lastGroup = groups[groups.length - 1];
  const lastStep = lastGroup?.steps[lastGroup.steps.length - 1]?.step;
  // We're mid-tool-call when the most recent step is an action with no
  // observation yet (observation always lands as a separate step when the
  // tool resolves). Show a "Working..." placeholder beneath the action so the
  // user has feedback that something is happening between the LLM's tool
  // dispatch and the tool's reply.
  const awaitingObservation = isActive && lastStep?.type === 'action';
  // Also show a generic "Thinking..." when the executor is active but no
  // steps have streamed yet for the current iteration (model is still
  // deciding its next move).
  const awaitingFirstStep = isActive && (!lastGroup || lastGroup.steps.length === 0);
  // Live token stream for the in-flight iteration - the agent's reasoning/narration and
  // final answer as they generate, so a long turn reads as active typing instead of a
  // generic spinner. Cleared per-iteration when the terminal step lands (store side).
  const pendingText = isActive ? execution.pendingTextByIteration?.[execution.lastKnownIteration] : undefined;
  const hasPendingText = !!pendingText && pendingText.length > 0;

  return (
    <Box
      data-testid={`iteration-stream-${executionId}`}
      sx={{ display: 'flex', flexDirection: 'column', gap: 1, py: 1 }}
    >
      {/* Status header - suppressed when there's nothing meaningful to show
          yet. For a fresh run with no iteration steps and no abort button,
          rendering a bare "Starting..." chip alone reads as visual noise.
          We still surface the header during active runs (status pill + abort
          button) so the user has feedback and a way to bail out. */}
      {(isActive || visibleIterationCount > 0 || execution.pendingPermission) && (
        <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: 'wrap' }}>
          {isActive ? <CircularProgress size="sm" thickness={2} sx={{ '--CircularProgress-size': '16px' }} /> : null}
          <Chip size="sm" color={statusMeta.color}>
            {statusMeta.label}
          </Chip>
          {visibleIterationCount > 0 ? (
            <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
              {visibleIterationCount} iteration{visibleIterationCount === 1 ? '' : 's'}
            </Typography>
          ) : null}
          {/* Live elapsed time during active runs - grounds the wait in real
              data so the rotating "Thinking..." copy doesn't feel like the
              only signal that progress is being made. Re-renders ~1/s; the
              underlying interval lives in the child so toggling visibility
              doesn't leak timers. */}
          {isActive && execution.startedAt ? <ElapsedTime startedAt={execution.startedAt} /> : null}
          <Box sx={{ flex: 1 }} />
          <AbortButton executionId={executionId} status={execution.status} />
        </Stack>
      )}

      <PermissionCard executionId={executionId} />

      <AccordionGroup size="sm" sx={{ '--ListItem-paddingY': '0.25rem' }}>
        {groups
          // The `final_answer` step is already surfaced prominently in the
          // success Box below the accordions - rendering it again inside the
          // last iteration's accordion was a double-render of the same text.
          // CLI matches: shows thoughts/actions in the trace, then the final
          // answer once as the message body. Filter the step out at the group
          // level so an iteration that contained only a final_answer step
          // doesn't render an empty accordion.
          .map(group => ({
            ...group,
            steps: group.steps.filter(s => s.step.type !== 'final_answer'),
          }))
          .filter(group => group.steps.length > 0)
          .map(group => {
            const isLast = group.iteration === lastIteration;
            // Auto-collapse past iterations as soon as a newer one arrives:
            // the "current" iteration is the focal point of the live trace,
            // and a long observation in a finished iteration pushes the input
            // off-screen. User can re-open any iteration - the override map
            // sticks across re-renders so the click isn't undone by the next
            // store update. `expandAll` (disclosure replay) wins absolutely.
            const userOverride = overrides.get(group.iteration);
            const expanded = expandAll || (userOverride ?? isLast);
            return (
              <Accordion
                key={group.iteration}
                expanded={expanded}
                onChange={(_, isExpanded) => toggleIteration(group.iteration, isExpanded)}
              >
                <AccordionSummary>
                  <Typography level="body-sm" sx={{ fontWeight: 500 }}>
                    Iteration {group.iteration + 1}
                  </Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Stack spacing={0.5}>
                    {group.steps.map(s => {
                      const stepKey = `${group.iteration}-${s.receivedAt}`;
                      const nestedChildId = stepToChildId.get(stepKey);
                      return (
                        <Box key={stepKey}>
                          {/* A tool-error observation is "recovered" unless the run
                              actually failed - the stream knows the run status, the
                              step doesn't. */}
                          <IterationStep step={s.step} recovered={execution.status !== 'failed'} />
                          {/* Inline child render for `delegate_to_agent` actions
                              that dispatched a foreground subagent. Background
                              subagents surface in the header badge instead. */}
                          {nestedChildId && execution?.childExecutions[nestedChildId] ? (
                            <SubagentStepNest
                              topLevelExecutionId={executionId}
                              child={execution.childExecutions[nestedChildId]}
                              depth={1}
                            />
                          ) : null}
                        </Box>
                      );
                    })}
                    {/* Live placeholder while a tool call is awaiting its
                        observation. The chip-level spinner above already
                        carries the "active" signal - adding a second spinner
                        here is visual noise, so we rely on the italic copy +
                        dashed border to convey "something is happening". The
                        copy is tool-specific when we know the tool name (we
                        do, it's on the action step's metadata) - gives the
                        user a real signal about what's happening behind the
                        scenes instead of generic "Running tool...". */}
                    {isLast && awaitingObservation ? (
                      <Box
                        data-testid={`iteration-stream-${executionId}-awaiting-observation`}
                        sx={{
                          pl: 2,
                          py: 0.75,
                          borderLeft: theme => `2px dashed ${theme.palette.neutral.outlinedBorder}`,
                        }}
                      >
                        <Typography level="body-sm" sx={{ color: 'text.tertiary', fontStyle: 'italic' }}>
                          {copyForRunningTool(
                            (lastStep as { metadata?: { toolName?: string } } | undefined)?.metadata?.toolName
                          )}
                        </Typography>
                      </Box>
                    ) : null}
                  </Stack>
                </AccordionDetails>
              </Accordion>
            );
          })}
        {/* Live streaming text for the in-flight iteration wins over the generic
            rotating copy - the user sees the agent's actual words as they type
            instead of a placeholder. Falls back to the rotating "Thinking..."
            copy only while the model has produced no text yet (e.g. generating a
            large tool-call argument, which streams as JSON rather than text). */}
        {hasPendingText ? (
          <StreamingText text={pendingText!} testId={`iteration-stream-${executionId}-streaming`} />
        ) : awaitingFirstStep ? (
          <ThinkingPlaceholder />
        ) : null}
      </AccordionGroup>

      {execution.status === 'aborted' ? (
        <Typography level="body-sm" sx={{ color: 'danger.softColor', fontStyle: 'italic' }}>
          Aborted at iteration {lastIteration + 1}.
        </Typography>
      ) : null}
      {execution.status === 'failed' && execution.failureReason ? (
        <Typography level="body-sm" sx={{ color: 'danger.softColor' }}>
          Failed: {execution.failureReason}
          {execution.errorMessage ? ` — ${execution.errorMessage}` : null}
        </Typography>
      ) : null}
      {execution.status === 'completed' && execution.answer && !hideFinalAnswer ? (
        <Box
          data-testid={`iteration-stream-${executionId}-final-answer`}
          sx={{
            mt: 1,
            p: 2,
            borderRadius: 'sm',
            backgroundColor: 'success.softBg',
            color: 'text.primary',
          }}
        >
          <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap' }}>
            {execution.answer}
          </Typography>
        </Box>
      ) : null}
    </Box>
  );
};

// Live-updating "running for N s" indicator. Lives in its own component so
// the 1Hz re-render is isolated to a tiny Typography node - the rest of the
// IterationStream (which re-renders only on store changes) stays still.
const ElapsedTime: FC<{ startedAt: number }> = ({ startedAt }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  // Compact: "7s" under a minute, "1m 12s" past it. Long-running agents
  // are rare but the format keeps the row readable when they happen.
  const label = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return (
    <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
      · {label}
    </Typography>
  );
};

// Live token stream for the in-flight iteration. Rendered in place of the rotating
// "Thinking..." copy the moment the agent produces any text, so a long turn shows the
// agent's real reasoning/narration typing out. Content is authoritative-once-terminal:
// the store clears this buffer when the iteration's persisted step lands, so it never
// double-renders alongside the finalized step.
const StreamingText: FC<{ text: string; testId: string }> = ({ text, testId }) => (
  <Box
    data-testid={testId}
    sx={{
      px: 2,
      py: 1,
      borderLeft: theme => `2px solid ${theme.palette.primary.softActiveBg}`,
    }}
  >
    <Typography level="body-sm" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap' }}>
      {text}
    </Typography>
  </Box>
);

// Extracted so the rotating-copy effect lives in its own component - keeps
// the hook unconditional under React rules and lets us mount/unmount cleanly
// when the parent toggles the gap state.
const ThinkingPlaceholder: FC = () => {
  const copy = useRotatingCopy(THINKING_COPY);
  return (
    <Box sx={{ px: 2, py: 1 }}>
      <Typography level="body-sm" sx={{ color: 'text.tertiary', fontStyle: 'italic' }}>
        {copy}
      </Typography>
    </Box>
  );
};

export default IterationStream;
