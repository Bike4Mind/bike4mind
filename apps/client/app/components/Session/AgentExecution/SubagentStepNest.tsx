/**
 * SubagentStepNest - indented sub-stream rendering a child subagent's
 * iteration steps below the parent action that triggered it.
 *
 * Mounted by `IterationStream` directly under each `delegate_to_agent` action
 * step that resolved to a foreground (non-background) child. Background
 * subagents are intentionally NOT nested here - they surface via the chat
 * header badge + completion toast instead.
 *
 * Visual model: dashed left border + tinted background to mark the nesting
 * level, agent-name heading at the top, then one row per child step in
 * iteration order.
 *
 * Supports recursive nesting up to MAX_INLINE_DEPTH levels. Each
 * nest uses `stepToChildId` ordinal matching (same invariant as IterationStream)
 * to map child `delegate_to_agent` action steps to their grandchildren.
 * Depth >= MAX_INLINE_DEPTH collapses behind a "View N more levels" button.
 */

import { FC, useMemo, useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/joy';
import { humanizeToolName } from '@bike4mind/agents/toolFormat';
import { type ChildExecution } from '@client/app/stores/useAgentExecutionStore';
import IterationStep from './IterationStep';
import { groupByIteration } from './IterationStream';

/**
 * Deepest level rendered inline. Children at this depth and beyond collapse
 * behind a "View N more levels" button. Currently equals MAX_SUBAGENT_DEPTH,
 * so the button is unreachable in practice: a depth-3 agent has
 * `delegate_to_agent` stripped and cannot produce children. Kept as
 * defense-in-depth for a future cap bump.
 */
const MAX_INLINE_DEPTH = 3;

interface SubagentStepNestProps {
  /** Top-level parent execution that ultimately owns this nest (store key). */
  topLevelExecutionId: string;
  /** The child execution to render. */
  child: ChildExecution;
  /** Current nesting depth: 1 for direct children of the top-level execution. */
  depth?: number;
}

/**
 * Build a step-key -> childExecutionId map for a child's own delegate actions,
 * mirroring the ordinal matching logic in IterationStream.stepToChildId.
 */
function buildStepToChildId(child: ChildExecution): Map<string, string> {
  // Invariant: Object.values(childExecutions) must preserve insertion order -
  // the Nth delegate_to_agent action maps to the Nth grandchild by that order.
  // This holds because store mutations use `{ ...node.childExecutions, [id]: ... }`
  // which appends new keys in insertion order. Any future refactor that rebuilds
  // childExecutions from scratch (e.g. sort, filter, assign) must preserve this.
  const allGrandchildren = Object.values(child.childExecutions ?? {});
  const map = new Map<string, string>();
  let cursor = 0;
  for (const item of child.iterations) {
    const isDelegate = item.step.type === 'action' && item.step.metadata?.toolName === 'delegate_to_agent';
    if (!isDelegate) continue;
    const grandchild = allGrandchildren[cursor];
    if (!grandchild) break;
    cursor += 1;
    if (grandchild.isBackground) continue;
    map.set(`${item.iteration}-${item.receivedAt}`, grandchild.executionId);
  }
  return map;
}

const SubagentStepNest: FC<SubagentStepNestProps> = ({ topLevelExecutionId, child, depth = 1 }) => {
  const [collapsed, setCollapsed] = useState(true);

  const groups = useMemo(() => groupByIteration(child.iterations), [child.iterations]);

  const pendingEntries = useMemo<Array<[number, string]>>(() => {
    const pending = child.pendingTextByIteration;
    if (!pending) return [];
    return Object.entries(pending)
      .map(([k, v]) => [Number(k), v] as [number, string])
      .sort((a, b) => a[0] - b[0]);
  }, [child.pendingTextByIteration]);

  const stepToGrandchildId = useMemo(
    () => (depth < MAX_INLINE_DEPTH ? buildStepToChildId(child) : new Map<string, string>()),
    [child, depth]
  );

  const foregroundGrandchildCount = useMemo(
    () => Object.values(child.childExecutions ?? {}).filter(gc => !gc.isBackground).length,
    [child.childExecutions]
  );

  return (
    <Box
      data-testid={`subagent-nest-${child.executionId}`}
      sx={theme => ({
        ml: 2,
        mt: 0.5,
        pl: 1.5,
        py: 0.75,
        borderLeft: `2px dashed ${theme.palette.primary.outlinedBorder}`,
        backgroundColor: theme.palette.background.level1,
        borderRadius: 'xs',
      })}
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <Typography level="body-xs" sx={{ fontWeight: 600, color: 'text.secondary' }}>
          {child.agentName}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
          {renderChildStatusLabel(child)}
        </Typography>
      </Stack>

      {groups.map(group => (
        <Box key={group.iteration} sx={{ mb: 0.5 }}>
          <Typography level="body-xs" sx={{ color: 'text.tertiary', fontWeight: 500 }}>
            {child.agentName} → iteration {group.iteration + 1}
          </Typography>
          <Stack spacing={0.25} sx={{ mt: 0.25 }}>
            {group.steps.map(s => {
              const stepKey = `${s.iteration}-${s.receivedAt}`;
              const grandchildId = stepToGrandchildId.get(stepKey);
              const grandchild = grandchildId ? child.childExecutions[grandchildId] : undefined;
              return (
                <Box key={stepKey}>
                  <IterationStep step={s.step} />
                  {grandchild && depth < MAX_INLINE_DEPTH && (
                    <SubagentStepNest topLevelExecutionId={topLevelExecutionId} child={grandchild} depth={depth + 1} />
                  )}
                </Box>
              );
            })}
          </Stack>
        </Box>
      ))}

      {pendingEntries.map(([iteration, text]) => (
        <Box key={`pending-${iteration}`} sx={{ mb: 0.5 }} data-testid={`subagent-streaming-${iteration}`}>
          <Typography level="body-xs" sx={{ color: 'text.tertiary', fontWeight: 500 }}>
            {child.agentName} → iteration {iteration + 1} (streaming…)
          </Typography>
          <Typography
            level="body-xs"
            sx={{
              mt: 0.25,
              whiteSpace: 'pre-wrap',
              color: 'text.secondary',
              fontStyle: 'italic',
              opacity: 0.85,
            }}
          >
            {text}
          </Typography>
        </Box>
      ))}

      {child.status === 'failed' && child.error ? (
        <Typography level="body-xs" sx={{ color: 'danger.softColor', mt: 0.5 }}>
          {child.isTimeout ? 'Timed out: ' : 'Failed: '}
          {child.error}
        </Typography>
      ) : null}

      {/* Depth cap: collapse grandchildren beyond MAX_INLINE_DEPTH behind a disclosure. */}
      {depth >= MAX_INLINE_DEPTH && foregroundGrandchildCount > 0 && (
        <Box sx={{ mt: 0.5 }}>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => setCollapsed(c => !c)}
            data-testid={`subagent-nest-expand-${child.executionId}`}
            sx={{ fontSize: 'xs', py: 0.25, px: 0.5, minHeight: 'unset' }}
          >
            {collapsed
              ? `View ${foregroundGrandchildCount} nested agent${foregroundGrandchildCount === 1 ? '' : 's'}`
              : 'Collapse'}
          </Button>
          {!collapsed &&
            Object.values(child.childExecutions ?? {})
              .filter(gc => !gc.isBackground)
              .map(gc => (
                <SubagentStepNest
                  key={gc.executionId}
                  topLevelExecutionId={topLevelExecutionId}
                  child={gc}
                  depth={depth + 1}
                />
              ))}
        </Box>
      )}
    </Box>
  );
};

function renderChildStatusLabel(child: ChildExecution): string {
  const iterCount = child.iterations.length === 0 ? 0 : child.iterations[child.iterations.length - 1].iteration + 1;
  const iterLabel = iterCount === 0 ? 'starting' : `${iterCount} iteration${iterCount === 1 ? '' : 's'}`;
  if (child.status !== 'running' && child.status !== 'pending') {
    return `${iterLabel} · ${child.status}`;
  }
  if (child.lastProgress) {
    return iterCount === 0 ? child.lastProgress : `${child.lastProgress} · iter ${iterCount}`;
  }
  const lastAction = child.iterations.findLast(s => s.step.type === 'action' && s.step.metadata?.toolName);
  const humanized = humanizeToolName(lastAction?.step.metadata?.toolName);
  if (humanized) return `${humanized} · iter ${iterCount}`;
  return `${iterLabel} · running`;
}

export default SubagentStepNest;
