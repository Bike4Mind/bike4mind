import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import { AGENT_STATE_LABEL, type AgentState } from '@shared/agentState';
import type { ViewAction, ViewAgent, ViewSnapshot } from '@shared/viewSnapshot';
import { stateLampColor } from './statePalette';
import { AgentPrIndicator } from './AgentPrIndicator';

/*
 * Built on the view contract alone, as TileWall is: it may import only @shared/viewSnapshot, @shared/agentState,
 * ./statePalette, ./AgentPrIndicator, React and the UI kit. snapshotView.tsx hosts it.
 */

const SIZE = 640;
const CENTER = SIZE / 2;
/** Rings, in viewBox units: the first sits clear of the root, the last stays inside the frame and its labels. */
const FIRST_RING = 120;
const MAX_RADIUS = 260;
const LONE_RING = 180;
const ROOT_NODE_RADIUS = 22;

export interface ConstellationNode {
  id: string;
  parentId: string | null;
  agent: ViewAgent;
  level: number;
  x: number;
  y: number;
}

/**
 * A radial tree with no physics and no randomness: each agent takes an angular sector of its parent's, in
 * proportion to the agents beneath it, and sits at the middle of it on the ring for its level. The same
 * roster always gives the same picture. An agent whose parent is not in the roster hangs from the root.
 */
export function layoutConstellation(agents: readonly ViewAgent[]): ConstellationNode[] {
  const ids = new Set(agents.map(agent => agent.id));
  const children = new Map<string | null, ViewAgent[]>();
  for (const agent of agents) {
    const key = ids.has(agent.parentId) && agent.parentId !== agent.id ? agent.parentId : null;
    children.set(key, [...(children.get(key) ?? []), agent]);
  }

  const visited = new Set<string>();
  const weight = new Map<string, number>();
  const measure = (agent: ViewAgent): number => {
    if (visited.has(agent.id)) return 0;
    visited.add(agent.id);
    const total = 1 + (children.get(agent.id) ?? []).reduce((sum, child) => sum + measure(child), 0);
    weight.set(agent.id, total);
    return total;
  };
  const top = children.get(null) ?? [];
  for (const agent of top) measure(agent);

  const placed: ConstellationNode[] = [];
  const seen = new Set<string>();
  let deepest = 1;
  const place = (agent: ViewAgent, parentId: string | null, level: number, start: number, end: number) => {
    if (seen.has(agent.id) || !weight.has(agent.id)) return;
    seen.add(agent.id);
    deepest = Math.max(deepest, level);
    const angle = (start + end) / 2;
    placed.push({ id: agent.id, parentId, agent, level, x: angle, y: 0 });
    const kids = (children.get(agent.id) ?? []).filter(child => weight.has(child.id));
    const kidsWeight = kids.reduce((sum, child) => sum + (weight.get(child.id) ?? 0), 0);
    let cursor = start;
    for (const child of kids) {
      const span = ((end - start) * (weight.get(child.id) ?? 0)) / kidsWeight;
      place(child, agent.id, level + 1, cursor, cursor + span);
      cursor += span;
    }
  };
  const topWeight = top.reduce((sum, agent) => sum + (weight.get(agent.id) ?? 0), 0);
  let cursor = -Math.PI / 2;
  for (const agent of top) {
    const span = (2 * Math.PI * (weight.get(agent.id) ?? 0)) / topWeight;
    place(agent, null, 1, cursor, cursor + span);
    cursor += span;
  }

  const ringGap = deepest > 1 ? (MAX_RADIUS - FIRST_RING) / (deepest - 1) : 0;
  return placed.map(node => {
    const angle = node.x;
    const radius = deepest > 1 ? FIRST_RING + ringGap * (node.level - 1) : LONE_RING;
    return {
      ...node,
      x: round(CENTER + radius * Math.cos(angle)),
      y: round(CENTER + radius * Math.sin(angle)),
    };
  });
}

const round = (value: number) => Math.round(value * 100) / 100;

/** Deeper agents are smaller, down to a floor that stays clickable. */
export const nodeRadius = (level: number) => Math.max(8, 18 - (level - 1) * 3);

const LINK_COLOR = 'var(--joy-palette-neutral-outlinedBorder)';
const LABEL_COLOR = 'var(--joy-palette-text-secondary)';

const halo = keyframes`
  0%, 100% { opacity: 0.9; }
  50% { opacity: 0.35; }
`;

const truncate = (text: string, max = 16) => (text.length > max ? `${text.slice(0, max - 1)}\u2026` : text);

function activate(event: React.KeyboardEvent, action: () => void) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  action();
}

function Node({
  testId,
  state,
  title,
  x,
  y,
  radius,
  agentId,
  pr,
  onOpen,
  onOpenPr,
}: {
  testId: string;
  state: AgentState;
  title: string;
  x: number;
  y: number;
  radius: number;
  agentId?: string;
  pr?: ViewAgent['pr'];
  onOpen(): void;
  onOpenPr?(): void;
}) {
  const color = stateLampColor(state);
  const asking = state === 'needs-you';
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${title}: ${AGENT_STATE_LABEL[state]}`}
      data-testid={testId}
      data-state={state}
      data-color={color}
      onClick={onOpen}
      onKeyDown={event => activate(event, onOpen)}
      style={{ cursor: 'pointer', opacity: state === 'paused' || state === 'stopped' || state === 'idle' ? 0.6 : 1 }}
    >
      {asking && (
        <Box
          component="circle"
          cx={x}
          cy={y}
          r={radius + 7}
          fill="none"
          stroke={color}
          strokeWidth={3}
          data-testid={`${testId}-ring`}
          sx={{
            animation: `${halo} 1.8s ease-in-out infinite`,
            '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
          }}
        />
      )}
      <circle cx={x} cy={y} r={radius} fill={color} />
      <title>{`${title}: ${AGENT_STATE_LABEL[state]}`}</title>
      <text x={x} y={y + radius + 14} textAnchor="middle" fontSize={11} fill={LABEL_COLOR} pointerEvents="none">
        {truncate(title)}
      </text>
      {pr && agentId && (
        <foreignObject x={x - 55} y={y + radius + 18} width={110} height={24}>
          <Box sx={{ display: 'flex', justifyContent: 'center' }}>
            <AgentPrIndicator agentId={agentId} pr={pr} onOpen={onOpenPr} compact />
          </Box>
        </foreignObject>
      )}
    </g>
  );
}

/**
 * Constellation: the orchestrating session at the centre, agents on rings around their parent, linked by
 * lines. Deeper agents are smaller; an agent that needs the user wears a ring. Selecting a node opens it.
 */
export function Constellation({ snapshot, onAction }: { snapshot: ViewSnapshot; onAction(action: ViewAction): void }) {
  const nodes = layoutConstellation(snapshot.agents);
  const position = new Map(nodes.map(node => [node.id, node]));
  return (
    <Box
      data-testid="orchestrator-constellation"
      sx={{
        position: 'relative',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 1,
      }}
    >
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="group"
        aria-label="Agent constellation"
        style={{ width: '100%', height: '100%', maxHeight: '100%' }}
      >
        {nodes.map(node => {
          const from = node.parentId ? position.get(node.parentId) : undefined;
          return (
            <line
              key={`link-${node.id}`}
              data-testid={`orchestrator-constellation-link-${node.id}`}
              x1={from ? from.x : CENTER}
              y1={from ? from.y : CENTER}
              x2={node.x}
              y2={node.y}
              stroke={LINK_COLOR}
              strokeWidth={1.5}
            />
          );
        })}
        {nodes.map(node => (
          <Node
            key={node.id}
            testId={`orchestrator-constellation-node-${node.id}`}
            state={node.agent.state}
            title={node.agent.title}
            agentId={node.id}
            pr={node.agent.pr}
            x={node.x}
            y={node.y}
            radius={nodeRadius(node.level)}
            onOpen={() => onAction({ kind: 'open-agent', agentId: node.id })}
            onOpenPr={() => onAction({ kind: 'open-pr', agentId: node.id })}
          />
        ))}
        <Node
          testId="orchestrator-constellation-root"
          state={snapshot.root.state}
          title="Orchestrator"
          x={CENTER}
          y={CENTER}
          radius={ROOT_NODE_RADIUS}
          onOpen={() => onAction({ kind: 'open-root' })}
        />
      </svg>
      {nodes.length === 0 && (
        <Typography
          level="body-sm"
          textColor="text.tertiary"
          data-testid="orchestrator-constellation-empty"
          sx={{ position: 'absolute', bottom: 16 }}
        >
          No agents yet
        </Typography>
      )}
    </Box>
  );
}
