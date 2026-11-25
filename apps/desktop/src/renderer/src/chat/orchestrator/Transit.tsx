import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import { AGENT_STATE_LABEL, type AgentState } from '@shared/agentState';
import type { ViewAction, ViewSnapshot } from '@shared/viewSnapshot';
import { stateJoyColor } from './statePalette';
import { AgentPrIndicator } from './AgentPrIndicator';
import { TRANSIT_STOPS, TRANSIT_STOP_LABEL, transitPhase, type TransitStop } from './transitPhase';

/*
 * Built on the view contract alone, as TileWall is: it may import only @shared/viewSnapshot, @shared/agentState,
 * ./statePalette, ./AgentPrIndicator, ./transitPhase, React and the UI kit. snapshotView.tsx hosts it.
 */

interface Rider {
  key: string;
  state: AgentState;
  title: string;
  line?: string;
  pr?: ViewSnapshot['agents'][number]['pr'];
  action: ViewAction;
}

const pulse = keyframes`
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.75); }
`;

function riders(snapshot: ViewSnapshot) {
  const atStop = new Map<TransitStop, Rider[]>(TRANSIT_STOPS.map(stop => [stop, []]));
  const offLine: Rider[] = [];
  const rootRider: Rider | undefined =
    snapshot.root.state === 'needs-you'
      ? {
          key: 'root',
          state: 'needs-you',
          title: 'The orchestrating conversation',
          line: 'Waiting for your approval',
          action: { kind: 'open-root' },
        }
      : undefined;
  if (rootRider) atStop.get('waiting')?.push(rootRider);
  for (const agent of snapshot.agents) {
    const line = agent.decision?.question ?? agent.now;
    const rider: Rider = {
      key: agent.id,
      state: agent.state,
      title: agent.title,
      line,
      pr: agent.pr,
      action: { kind: 'open-agent', agentId: agent.id },
    };
    const phase = transitPhase(agent.state, agent.now);
    if (phase === 'off-line') offLine.push(rider);
    else atStop.get(phase)?.push(rider);
  }
  return { atStop, offLine };
}

function RiderButton({ rider, onAction }: { rider: Rider; onAction(action: ViewAction): void }) {
  const color = stateJoyColor(rider.state);
  const asking = rider.state === 'needs-you';
  return (
    <Box
      role="button"
      tabIndex={0}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onAction(rider.action);
      }}
      onClick={() => onAction(rider.action)}
      aria-label={`${rider.title}: ${AGENT_STATE_LABEL[rider.state]}`}
      data-testid={`orchestrator-transit-agent-${rider.key}`}
      data-state={rider.state}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0.25,
        minWidth: 0,
        width: '100%',
        p: 1,
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
        opacity: rider.state === 'paused' || rider.state === 'stopped' || rider.state === 'idle' ? 0.55 : 1,
        '&:hover': { bgcolor: 'background.level1', opacity: 1 },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'focusVisible', outlineOffset: 2 },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
        <Box
          aria-hidden
          data-testid="orchestrator-transit-dot"
          data-color={color}
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            flexShrink: 0,
            bgcolor: `${color}.solidBg`,
            animation: rider.state === 'working' ? `${pulse} 1.6s ease-in-out infinite` : 'none',
            '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
          }}
        />
        <Typography level="title-sm" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {rider.title}
        </Typography>
      </Box>
      {rider.line && (
        <Typography level="body-xs" textColor="text.secondary" noWrap data-testid="orchestrator-transit-line">
          {rider.line}
        </Typography>
      )}
      <AgentPrIndicator
        agentId={rider.key}
        pr={rider.pr}
        onOpen={() => onAction({ kind: 'open-pr', agentId: rider.key })}
      />
    </Box>
  );
}

/**
 * Transit: a line of stops (Waiting, Planning, Working, Reviewing, Done) with each agent at its stop
 * (transitPhase). Failed and stopped agents sit off the line, in their own state colour. Selecting an
 * agent opens it in the peek drawer.
 */
export function Transit({ snapshot, onAction }: { snapshot: ViewSnapshot; onAction(action: ViewAction): void }) {
  const { atStop, offLine } = riders(snapshot);
  const empty = snapshot.agents.length === 0 && snapshot.root.state !== 'needs-you';
  return (
    <Box
      data-testid="orchestrator-transit"
      sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, p: 2, overflow: 'auto' }}
    >
      <Box sx={{ position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 1.5 }}>
        <Box
          aria-hidden
          data-testid="orchestrator-transit-line-track"
          sx={{ position: 'absolute', left: '10%', right: '10%', top: 7, height: 2, bgcolor: 'divider' }}
        />
        {TRANSIT_STOPS.map(stop => {
          const here = atStop.get(stop) ?? [];
          return (
            <Box
              key={stop}
              data-testid={`orchestrator-transit-stop-${stop}`}
              data-count={here.length}
              sx={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'stretch',
                gap: 1,
                minWidth: 0,
              }}
            >
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
                <Box
                  aria-hidden
                  sx={{
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    border: '3px solid',
                    borderColor: here.length > 0 ? 'primary.solidBg' : 'neutral.outlinedBorder',
                    bgcolor: 'background.body',
                    zIndex: 1,
                  }}
                />
                <Typography level="title-sm">{TRANSIT_STOP_LABEL[stop]}</Typography>
              </Box>
              {here.map(rider => (
                <RiderButton key={rider.key} rider={rider} onAction={onAction} />
              ))}
            </Box>
          );
        })}
      </Box>
      {offLine.length > 0 && (
        <Box data-testid="orchestrator-transit-off-line" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Typography level="body-xs" textColor="text.tertiary">
            Off the line
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 1 }}>
            {offLine.map(rider => (
              <RiderButton key={rider.key} rider={rider} onAction={onAction} />
            ))}
          </Box>
        </Box>
      )}
      {empty && (
        <Typography level="body-sm" textColor="text.tertiary" data-testid="orchestrator-transit-empty">
          No agents yet
        </Typography>
      )}
    </Box>
  );
}
