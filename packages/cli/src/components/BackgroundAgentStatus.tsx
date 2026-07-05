import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useCliStore, selectActiveBackgroundAgents } from '../store';
import { useShallow } from 'zustand/react/shallow';
import type { BackgroundAgentJob } from '../agents/types';

/**
 * Renders a single job item (used in both grouped and ungrouped views)
 */
const JobItem = React.memo(function JobItem({
  job,
  indented = false,
}: {
  job: BackgroundAgentJob;
  indented?: boolean;
}) {
  const elapsed = Math.round((Date.now() - job.startTime) / 1000);
  const maxTaskLength = indented ? 50 : 60;
  const taskPreview = job.task.length > maxTaskLength ? job.task.slice(0, maxTaskLength - 3) + '...' : job.task;
  const isQueued = job.status === 'queued';

  return (
    <Box>
      {indented && <Text> </Text>}
      {isQueued ? (
        <Text color="yellow">⏳</Text>
      ) : (
        <Text color="blue">
          <Spinner type="dots" />
        </Text>
      )}
      <Text color={isQueued ? 'yellow' : 'blue'}> {job.agentName}</Text>
      <Text dimColor>
        {' '}
        [{job.id}] {taskPreview} {isQueued ? '(queued)' : `(${elapsed}s)`}
      </Text>
    </Box>
  );
});

/**
 * Counts running and queued jobs, returning a formatted status string
 */
function formatStatusCounts(jobs: BackgroundAgentJob[]): string {
  let running = 0;
  let queued = 0;
  for (const job of jobs) {
    if (job.status === 'running') running++;
    else if (job.status === 'queued') queued++;
  }
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (queued > 0) parts.push(`${queued} queued`);
  return parts.join(', ');
}

/**
 * Groups jobs by turnId and returns structured group data
 */
function groupJobsByTurn(jobs: BackgroundAgentJob[]): {
  groups: Map<string, { description?: string; jobs: BackgroundAgentJob[] }>;
  ungrouped: BackgroundAgentJob[];
} {
  const groups = new Map<string, { description?: string; jobs: BackgroundAgentJob[] }>();
  const ungrouped: BackgroundAgentJob[] = [];

  for (const job of jobs) {
    if (job.turnId) {
      const existing = groups.get(job.turnId);
      if (existing) {
        existing.jobs.push(job);
        // Use first available group description
        if (!existing.description && job.groupDescription) {
          existing.description = job.groupDescription;
        }
      } else {
        groups.set(job.turnId, {
          description: job.groupDescription,
          jobs: [job],
        });
      }
    } else {
      ungrouped.push(job);
    }
  }

  return { groups, ungrouped };
}

/**
 * Displays the status of background agent jobs above the input prompt.
 * Jobs are grouped by turnId with the group description as a header.
 * Only renders when there are active (running/queued) background agents.
 */
export function BackgroundAgentStatus() {
  const activeJobs = useCliStore(useShallow(selectActiveBackgroundAgents));
  const permissionPrompt = useCliStore(state => state.permissionPrompt);

  // Memoize the grouping computation to avoid recalculating on every render
  const { groups, ungrouped } = useMemo(() => groupJobsByTurn(activeJobs), [activeJobs]);

  if (activeJobs.length === 0) return null;

  // When a permission prompt is active, show a static summary instead of spinners.
  // Ink spinners cause frequent re-renders that disrupt SelectInput keyboard handling.
  if (permissionPrompt) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Background agents: {formatStatusCounts(activeJobs)}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={0}>
      {/* Render grouped jobs with headers */}
      {Array.from(groups.entries()).map(([turnId, group]) => (
        <Box key={turnId} flexDirection="column">
          {/* Group header */}
          <Box>
            <Text color="magenta">▸ </Text>
            <Text color="magenta" bold>
              {group.description || 'Background Tasks'}
            </Text>
            <Text dimColor> ({formatStatusCounts(group.jobs)})</Text>
          </Box>
          {/* Indented job items */}
          {group.jobs.map(job => (
            <JobItem key={job.id} job={job} indented />
          ))}
        </Box>
      ))}

      {/* Render ungrouped jobs (legacy/no turnId) */}
      {ungrouped.map(job => (
        <JobItem key={job.id} job={job} />
      ))}
    </Box>
  );
}
