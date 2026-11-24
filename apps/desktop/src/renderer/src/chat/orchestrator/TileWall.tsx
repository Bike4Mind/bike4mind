import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import { AGENT_STATE_LABEL, type AgentState } from '@shared/agentState';
import type { ViewAction, ViewSnapshot } from '@shared/viewSnapshot';
import { SKIN_CARD_VARIABLE, stateJoyColor, stateSkinSx } from './statePalette';
import { AgentPrIndicator } from './AgentPrIndicator';

/*
 * Built on the view contract alone: this file may import only @shared/viewSnapshot, @shared/agentState,
 * ./statePalette, ./AgentPrIndicator, React and the UI kit (TileWall.test.tsx holds it to that), so it is
 * the proof that a view needs nothing from the stage. snapshotView.tsx hosts it.
 */

/** Needs-you first, quiet agents last; within a rank the snapshot's own urgency order holds. */
const TILE_RANK: Record<AgentState, number> = {
  'needs-you': 0,
  working: 1,
  waiting: 1,
  failed: 2,
  paused: 2,
  done: 3,
  stopped: 4,
  idle: 4,
};

const DIMMED: ReadonlySet<AgentState> = new Set(['paused', 'stopped', 'idle']);

interface Tile {
  key: string;
  state: AgentState;
  title: string;
  line?: string;
  pr?: { number: number; state: string };
  action: ViewAction;
}

function tiles(snapshot: ViewSnapshot): Tile[] {
  const agentTiles = snapshot.agents
    .map((agent, order) => ({ agent, order }))
    .sort((a, b) => TILE_RANK[a.agent.state] - TILE_RANK[b.agent.state] || a.order - b.order)
    .map(({ agent }): Tile => ({
      key: agent.id,
      state: agent.state,
      title: agent.title,
      line: agent.decision?.question ?? agent.now,
      pr: agent.pr,
      action: { kind: 'open-agent', agentId: agent.id },
    }));
  if (snapshot.root.state !== 'needs-you') return agentTiles;
  const rootTile: Tile = {
    key: 'root',
    state: 'needs-you',
    title: 'The orchestrating conversation',
    line: 'Waiting for your approval',
    action: { kind: 'open-root' },
  };
  return [rootTile, ...agentTiles];
}

const sweep = keyframes`
  from { transform: translateX(-100%); }
  to { transform: translateX(250%); }
`;

/** Working: a thin line under the tile that keeps moving while the agent does. Still under reduced motion. */
function Hairline() {
  return (
    <Box
      aria-hidden
      data-testid="orchestrator-tile-hairline"
      sx={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, overflow: 'hidden' }}
    >
      <Box
        sx={{
          width: '40%',
          height: '100%',
          bgcolor: 'primary.solidBg',
          opacity: 0.7,
          animation: `${sweep} 2.4s ease-in-out infinite`,
          '@media (prefers-reduced-motion: reduce)': {
            animation: 'none',
            transform: 'none',
            width: '100%',
            opacity: 0.35,
          },
        }}
      />
    </Box>
  );
}

/**
 * Tile Wall: one calm tile per agent, its title and what it is doing now. Selecting a tile opens it in the
 * peek drawer, where answering and approving live; the contract only lets a view open things.
 */
export function TileWall({ snapshot, onAction }: { snapshot: ViewSnapshot; onAction(action: ViewAction): void }) {
  return (
    <Box
      data-testid="orchestrator-tile-wall"
      sx={{
        flex: 1,
        alignSelf: 'flex-start',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 1.5,
        p: 2,
      }}
    >
      {tiles(snapshot).map(tile => {
        const color = stateJoyColor(tile.state);
        const asking = tile.state === 'needs-you';
        return (
          <Box
            key={tile.key}
            role="button"
            tabIndex={0}
            onKeyDown={event => {
              if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
              event.preventDefault();
              onAction(tile.action);
            }}
            onClick={() => onAction(tile.action)}
            aria-label={`${tile.title}: ${AGENT_STATE_LABEL[tile.state]}`}
            data-testid={`orchestrator-tile-${tile.key}`}
            data-state={tile.state}
            sx={{
              position: 'relative',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              gap: 0.5,
              minHeight: 88,
              p: 1.5,
              textAlign: 'left',
              font: 'inherit',
              color: 'inherit',
              cursor: 'pointer',
              borderRadius: 'md',
              bgcolor: `var(${SKIN_CARD_VARIABLE}, var(--joy-palette-background-surface))`,
              border: asking ? '2px solid' : '1px solid',
              borderColor: asking ? 'warning.outlinedBorder' : 'divider',
              opacity: DIMMED.has(tile.state) ? 0.55 : 1,
              transition: 'opacity 300ms, border-color 300ms',
              '&:hover': { bgcolor: 'background.level1', opacity: 1 },
              '&:focus-visible': { outline: '2px solid', outlineColor: 'focusVisible', outlineOffset: 2 },
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
              <Box
                aria-hidden
                data-testid="orchestrator-tile-dot"
                data-color={color}
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  flexShrink: 0,
                  bgcolor: `${color}.solidBg`,
                  ...stateSkinSx(tile.state, 'solid'),
                }}
              />
              <Typography level="title-sm" noWrap sx={{ flex: 1, minWidth: 0 }}>
                {tile.title}
              </Typography>
              <AgentPrIndicator
                agentId={tile.key}
                pr={tile.pr}
                onOpen={() => onAction({ kind: 'open-pr', agentId: tile.key })}
                testId="orchestrator-tile-pr"
              />
            </Box>
            {tile.line && (
              <Typography
                level="body-sm"
                textColor={asking ? 'text.primary' : 'text.secondary'}
                data-testid="orchestrator-tile-line"
                sx={{
                  display: '-webkit-box',
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  overflowWrap: 'anywhere',
                }}
              >
                {tile.line}
              </Typography>
            )}
            {tile.state === 'working' && <Hairline />}
          </Box>
        );
      })}
    </Box>
  );
}
