import { useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { ChildOutcome } from '@shared/agentOutcome';
import { isAgentSession, type ChatSessionStatus, type ChatSessionSummary } from '@shared/chat';
import { BranchIcon, CheckIcon, WarningIcon } from './icons';
import { contentColumnSx } from './layout';
import { SessionBadge } from './SessionBadge';

/** What a chip shows: live status while the child runs, else how its last turn ended. */
export type ChildChipState = 'processing' | 'needs-action' | 'finished' | 'failed';

export interface ChildChip {
  id: string;
  title: string;
  state: ChildChipState;
  branch?: string;
  snippet?: string;
}

/** Outcomes that mean the child did not get its work done; the chip goes red for these. */
const FAILED_OUTCOMES: ReadonlySet<ChildOutcome> = new Set(['failed', 'aborted', 'turn-budget', 'context-limit']);

/** Chips beyond this collapse into a '+N' button so the strip stays one short row. */
export const MAX_VISIBLE_CHILDREN = 4;

// Whatever wants the user sorts first, so it survives the '+N' collapse.
const STATE_RANK: Record<ChildChipState, number> = { 'needs-action': 0, processing: 1, failed: 2, finished: 3 };

export function childChipState(
  status: ChatSessionStatus | undefined,
  outcome: ChildOutcome | undefined
): ChildChipState {
  if (status === 'processing' || status === 'needs-action') return status;
  return outcome && FAILED_OUTCOMES.has(outcome) ? 'failed' : 'finished';
}

/**
 * The open conversation's direct agent children, not archived, most urgent first and newest first
 * within a state. Side chats are excluded by isAgentSession; grandchildren belong to their own parent
 * (see backgroundTasks.ts spawnedSessions).
 */
export function childChips(
  sessions: readonly ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>,
  parentId: string | null
): ChildChip[] {
  if (!parentId) return [];
  return sessions
    .filter(session => session.origin?.parentSessionId === parentId && isAgentSession(session) && !session.archived)
    .map(session => {
      const branch = session.project?.workspace ? session.project.workspaceBranch : undefined;
      return {
        chip: {
          id: session.id,
          title: session.title,
          state: childChipState(statuses.get(session.id), session.lastOutcome),
          ...(branch ? { branch } : {}),
          ...(session.lastSnippet ? { snippet: session.lastSnippet } : {}),
        },
        createdAt: session.createdAt,
      };
    })
    .sort((a, b) => STATE_RANK[a.chip.state] - STATE_RANK[b.chip.state] || b.createdAt.localeCompare(a.createdAt))
    .map(entry => entry.chip);
}

const STATE_LABEL: Record<ChildChipState, string> = {
  processing: 'Working',
  'needs-action': 'Needs you',
  finished: 'Finished',
  failed: 'Did not finish',
};

function ChipIcon({ state }: { state: ChildChipState }) {
  if (state === 'processing' || state === 'needs-action') return <SessionBadge status={state} />;
  return (
    <Box
      aria-label={STATE_LABEL[state]}
      data-testid="children-strip-outcome-icon"
      data-state={state}
      sx={{
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
        color: state === 'failed' ? 'danger.plainColor' : 'success.plainColor',
        '& svg': { width: 14, height: 14 },
      }}
    >
      {state === 'failed' ? <WarningIcon /> : <CheckIcon />}
    </Box>
  );
}

function ChildChipButton({ chip, onOpen }: { chip: ChildChip; onOpen: (sessionId: string) => void }) {
  const button = (
    <Button
      size="sm"
      variant="outlined"
      color={chip.state === 'needs-action' ? 'warning' : 'neutral'}
      onClick={() => onOpen(chip.id)}
      startDecorator={<ChipIcon state={chip.state} />}
      aria-label={`${chip.title} - ${STATE_LABEL[chip.state]}`}
      data-testid="children-strip-chip-btn"
      data-state={chip.state}
      sx={{ flexShrink: 0, minHeight: 28, px: 1, gap: 0.5, fontWeight: 'md', maxWidth: 280, borderRadius: 'sm' }}
    >
      <Typography
        level="body-xs"
        textColor="text.primary"
        noWrap
        sx={{ minWidth: 0, maxWidth: 160 }}
        data-testid="children-strip-chip-title"
      >
        {chip.title}
      </Typography>
      {chip.branch && (
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          noWrap
          startDecorator={<BranchIcon />}
          sx={{ minWidth: 0, maxWidth: 120, '& svg': { width: 12, height: 12 } }}
          data-testid="children-strip-chip-branch"
        >
          {chip.branch}
        </Typography>
      )}
    </Button>
  );
  if (!chip.snippet) return button;
  return (
    <Tooltip
      title={chip.snippet}
      size="sm"
      variant="soft"
      placement="top-start"
      sx={{ maxWidth: 360, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
    >
      {button}
    </Tooltip>
  );
}

/**
 * One row above the composer: a chip per session the open conversation spawned, so the user can
 * see at a glance which are still working, which wait on them, and which are done, and jump to one.
 * Not drawn at all when the conversation has no children.
 */
export function ChildrenStrip({
  sessions,
  statuses,
  parentId,
  onOpenSession,
}: {
  sessions: readonly ChatSessionSummary[];
  statuses: ReadonlyMap<string, ChatSessionStatus>;
  parentId: string | null;
  onOpenSession: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const chips = childChips(sessions, statuses, parentId);
  if (chips.length === 0) return null;

  const overflow = chips.length - MAX_VISIBLE_CHILDREN;
  const collapsed = !expanded && overflow > 0;
  const visible = collapsed ? chips.slice(0, MAX_VISIBLE_CHILDREN) : chips;

  return (
    <Box sx={{ ...contentColumnSx, pt: 1 }} data-testid="children-strip">
      <Box
        role="list"
        aria-label="Sessions this conversation started"
        sx={{ display: 'flex', alignItems: 'center', gap: 0.75, overflowX: 'auto', pb: 0.25 }}
      >
        {visible.map(chip => (
          <Box role="listitem" key={chip.id} sx={{ display: 'flex', flexShrink: 0 }}>
            <ChildChipButton chip={chip} onOpen={onOpenSession} />
          </Box>
        ))}
        {overflow > 0 && (
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => setExpanded(open => !open)}
            aria-expanded={expanded}
            data-testid="children-strip-more-btn"
            sx={{ flexShrink: 0, minHeight: 28, px: 1, fontWeight: 'md' }}
          >
            {collapsed ? `+${overflow}` : 'Show less'}
          </Button>
        )}
      </Box>
    </Box>
  );
}
