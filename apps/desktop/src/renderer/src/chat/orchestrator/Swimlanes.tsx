import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import { AGENT_STATE_LABEL, type AgentState } from '@shared/agentState';
import type { ViewAction, ViewSnapshot } from '@shared/viewSnapshot';
import { stateJoyColor } from './statePalette';
import { AgentPrIndicator } from './AgentPrIndicator';

/*
 * Built on the view contract alone, as TileWall is: it may import only @shared/viewSnapshot, @shared/agentState,
 * ./statePalette, ./AgentPrIndicator, React and the UI kit. snapshotView.tsx hosts it.
 */

const DIMMED: ReadonlySet<AgentState> = new Set(['paused', 'stopped', 'idle']);

/** Per depth level (px); capped so a deep chain still leaves the lane room for its text. */
const INDENT_STEP = 20;
const MAX_INDENT_LEVELS = 6;

interface Lane {
  key: string;
  state: AgentState;
  title: string;
  line?: string;
  depth: number;
  pr?: SnapshotAgent['pr'];
  action: ViewAction;
}

type SnapshotAgent = ViewSnapshot['agents'][number];

/**
 * The roster arrives sorted by urgency, not by ancestry, so indenting it as given would strand a child
 * far from its parent. Depth-first from each agent whose parent is not in the roster, siblings in
 * roster order; anything a parent cycle leaves unreached is appended so no agent disappears.
 */
function inTreeOrder(agents: readonly SnapshotAgent[]): SnapshotAgent[] {
  const present = new Set(agents.map(agent => agent.id));
  const children = new Map<string, SnapshotAgent[]>();
  const tops: SnapshotAgent[] = [];
  for (const agent of agents) {
    if (!present.has(agent.parentId) || agent.parentId === agent.id) {
      tops.push(agent);
      continue;
    }
    children.set(agent.parentId, [...(children.get(agent.parentId) ?? []), agent]);
  }
  const ordered: SnapshotAgent[] = [];
  const seen = new Set<string>();
  const visit = (agent: SnapshotAgent) => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    ordered.push(agent);
    children.get(agent.id)?.forEach(visit);
  };
  tops.forEach(visit);
  agents.forEach(visit);
  return ordered;
}

function lanes(snapshot: ViewSnapshot): Lane[] {
  const agentLanes = inTreeOrder(snapshot.agents).map((agent): Lane => ({
    key: agent.id,
    state: agent.state,
    title: agent.title,
    line: agent.decision?.question ?? agent.now,
    depth: agent.depth,
    pr: agent.pr,
    action: { kind: 'open-agent', agentId: agent.id },
  }));
  if (snapshot.root.state !== 'needs-you') return agentLanes;
  const rootLane: Lane = {
    key: 'root',
    state: 'needs-you',
    title: 'The orchestrating conversation',
    line: 'Waiting for your approval',
    depth: 0,
    action: { kind: 'open-root' },
  };
  return [rootLane, ...agentLanes];
}

const pulse = keyframes`
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.75); }
`;

/**
 * Swimlanes: one lane per agent, each nested under its parent and indented by depth, each showing its
 * state and what it is doing now. Selecting a lane opens the agent in the peek drawer.
 */
export function Swimlanes({ snapshot, onAction }: { snapshot: ViewSnapshot; onAction(action: ViewAction): void }) {
  const all = lanes(snapshot);
  return (
    <Box
      data-testid="orchestrator-swimlanes"
      sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.75, p: 2, overflowY: 'auto' }}
    >
      {all.length === 0 && (
        <Typography level="body-sm" textColor="text.tertiary" data-testid="orchestrator-swimlanes-empty">
          No agents yet
        </Typography>
      )}
      {all.map(lane => {
        const color = stateJoyColor(lane.state);
        const asking = lane.state === 'needs-you';
        return (
          <Box
            key={lane.key}
            role="button"
            tabIndex={0}
            onKeyDown={event => {
              if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
              event.preventDefault();
              onAction(lane.action);
            }}
            onClick={() => onAction(lane.action)}
            aria-label={`${lane.title}: ${AGENT_STATE_LABEL[lane.state]}`}
            data-testid={`orchestrator-swimlanes-lane-${lane.key}`}
            data-state={lane.state}
            data-depth={lane.depth}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.25,
              minWidth: 0,
              py: 1,
              pr: 1.5,
              pl: `${12 + Math.min(Math.max(lane.depth - 1, 0), MAX_INDENT_LEVELS) * INDENT_STEP}px`,
              textAlign: 'left',
              font: 'inherit',
              color: 'inherit',
              cursor: 'pointer',
              borderRadius: 'md',
              bgcolor: 'background.surface',
              border: asking ? '2px solid' : '1px solid',
              borderColor: asking ? 'warning.outlinedBorder' : 'divider',
              borderLeft: '4px solid',
              borderLeftColor: `${color}.solidBg`,
              opacity: DIMMED.has(lane.state) ? 0.55 : 1,
              transition: 'opacity 300ms, border-color 300ms',
              '&:hover': { bgcolor: 'background.level1', opacity: 1 },
              '&:focus-visible': { outline: '2px solid', outlineColor: 'focusVisible', outlineOffset: 2 },
            }}
          >
            <Box
              aria-hidden
              data-testid="orchestrator-swimlanes-dot"
              data-color={color}
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                flexShrink: 0,
                bgcolor: `${color}.solidBg`,
                animation: lane.state === 'working' ? `${pulse} 1.6s ease-in-out infinite` : 'none',
                '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
              }}
            />
            <Typography level="title-sm" noWrap sx={{ flex: '0 1 220px', minWidth: 0 }}>
              {lane.title}
            </Typography>
            <Chip size="sm" variant="soft" color={color} data-testid="orchestrator-swimlanes-chip">
              {AGENT_STATE_LABEL[lane.state]}
            </Chip>
            <Typography
              level="body-sm"
              textColor={asking ? 'text.primary' : 'text.secondary'}
              noWrap
              data-testid="orchestrator-swimlanes-line"
              sx={{ flex: 1, minWidth: 0 }}
            >
              {lane.line ?? ''}
            </Typography>
            <AgentPrIndicator
              agentId={lane.key}
              pr={lane.pr}
              onOpen={() => onAction({ kind: 'open-pr', agentId: lane.key })}
            />
          </Box>
        );
      })}
    </Box>
  );
}
