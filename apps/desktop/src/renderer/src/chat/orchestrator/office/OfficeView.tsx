import { useMemo } from 'react';
import { Box, Button, Typography } from '@mui/joy';
import { keyframes } from '@mui/system';
import type { AgentView } from '../roster';
import type { OrchestratorViewProps } from '../OrchestratorStage';
import { AgentPrIndicator } from '../AgentPrIndicator';
import { OFFICE_CAST, OFFICE_PARENT, assignOfficeCast } from './officeCast';
import { OFFICE_ROOMS, type OfficeRoom } from './officeLayout';
import { groupOfficeAgents } from './scene';
import { OfficeBackdrop } from './OfficeBackdrop';
import { OfficeSprite } from './OfficeSprite';

const ROOM_BOUNDS: Record<OfficeRoom, { x: number; y: number; width: number; height: number; columns: number }> = {
  reception: { x: 4, y: 56, width: 14, height: 14, columns: 2 },
  desks: { x: 23, y: 43, width: 28, height: 45, columns: 3 },
  'manager-door': { x: 17, y: 37, width: 33, height: 9, columns: 5 },
  'break-room': { x: 59, y: 21, width: 32, height: 25, columns: 4 },
  'conference-room': { x: 75, y: 57, width: 21, height: 32, columns: 3 },
};
const alertBob = keyframes`0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2px); }`;
const TRAVEL_MS = 1200;
const ROW_STEP = 0.43;

type Placement = { agent: AgentView; room: OfficeRoom; left: number; top: number };

// Agents render in id order in one layer, never inside their room: moving a node between parents
// (or reordering siblings) drops its previous computed style, so the walk would not animate.
function placeAgents(rooms: ReadonlyMap<OfficeRoom, readonly AgentView[]>): Placement[] {
  const placements: Placement[] = [];
  for (const [room, members] of rooms) {
    const bounds = ROOM_BOUNDS[room];
    members.forEach((agent, index) =>
      placements.push({
        agent,
        room,
        left: bounds.x + (index % bounds.columns) * (bounds.width / bounds.columns),
        top: bounds.y + Math.floor(index / bounds.columns) * ROW_STEP * bounds.height,
      })
    );
  }
  return placements.sort((a, b) => (a.agent.id < b.agent.id ? -1 : a.agent.id > b.agent.id ? 1 : 0));
}

const STATE_COLOR = {
  working: '#e7bc55',
  'needs-you': '#ffe778',
  done: '#96c780',
  failed: '#ee8c75',
  idle: '#c4c5b1',
  stopped: '#c4c5b1',
};

export function OfficeView({
  agents,
  parent,
  onSelect,
  onOpenPr,
  selectedId,
  onInnkeeperSelect,
  sceneOverlay,
  agentDetailsOverlay,
  desk,
  celebrating,
}: OrchestratorViewProps) {
  const cast = useMemo(() => assignOfficeCast(agents), [agents]);
  const rooms = useMemo(() => groupOfficeAgents(agents), [agents]);
  const placements = useMemo(() => placeAgents(rooms), [rooms]);
  const parentNeedsAction = parent?.status === 'needs-action';

  return (
    <Box
      data-testid="orchestrator-office"
      sx={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        background: '#202e2c',
        overflow: 'auto',
        containerType: 'size',
      }}
    >
      <Box
        sx={{
          position: 'relative',
          width: 'min(100cqw, 156.25cqh)',
          aspectRatio: '1000 / 640',
          flexShrink: 0,
          isolation: 'isolate',
          anchorName: '--orchestrator-scene',
          containerType: 'size',
          '& [data-office-sprite]': { width: 'clamp(26px, 3.8cqw, 48px)', height: 'auto' },
        }}
      >
        <OfficeBackdrop />
        {sceneOverlay}
        <Button
          data-testid="office-parent"
          data-conversation-toggle
          aria-label={`${OFFICE_PARENT}, parent session${parentNeedsAction ? ', needs you' : ''}`}
          onClick={() => onInnkeeperSelect?.()}
          disabled={!onInnkeeperSelect}
          variant="plain"
          sx={{
            position: 'absolute',
            left: '9.6%',
            top: '15.5%',
            p: 0,
            minWidth: 0,
            background: 'transparent',
            '&:hover': { background: '#fff2' },
            display: 'flex',
            flexDirection: 'column',
            zIndex: 3,
          }}
        >
          {parentNeedsAction && (
            <Box
              component="span"
              data-testid="office-parent-alert"
              aria-hidden="true"
              sx={{
                position: 'absolute',
                top: '-18px',
                right: '-10px',
                minWidth: 16,
                padding: '1px 4px',
                fontFamily: 'monospace',
                fontWeight: 700,
                fontSize: 12,
                lineHeight: '14px',
                textAlign: 'center',
                color: '#344438',
                background: '#ffe778',
                border: '2px solid #344438',
                animation: `${alertBob} 900ms steps(2, end) infinite`,
                '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
              }}
            >
              !
            </Box>
          )}
          <OfficeSprite
            name={OFFICE_PARENT}
            resting={celebrating}
            working={parent?.status === 'processing'}
            attention={parentNeedsAction}
          />
          <span
            style={{
              color: '#f4edcd',
              background: '#27382de6',
              padding: '2px 5px',
              fontFamily: 'monospace',
              fontSize: 10,
            }}
          >
            {OFFICE_PARENT}
          </span>
        </Button>
        {desk?.reply && desk.conversationHidden && (
          <Button
            data-testid="office-parent-reply"
            onClick={() => desk.onReadReply(desk.reply!.id)}
            sx={{
              position: 'absolute',
              left: '3%',
              top: '8%',
              maxWidth: '27%',
              zIndex: 5,
              fontSize: 11,
              maxHeight: 56,
              overflow: 'hidden',
              background: '#f0e7cb',
              color: '#344438',
              border: '2px solid #344438',
              boxShadow: '2px 2px 0 #27382d99',
              borderRadius: 0,
              '&:hover': { background: '#f7efd6' },
            }}
          >
            {desk.reply.snippet}
          </Button>
        )}
        {OFFICE_ROOMS.map(room => {
          const bounds = ROOM_BOUNDS[room.id];
          return (
            <Box
              key={room.id}
              component="section"
              aria-label={room.label}
              data-testid={`office-room-${room.id}`}
              data-occupants={rooms.get(room.id)?.length ?? 0}
              sx={{
                position: 'absolute',
                left: `${bounds.x}%`,
                top: `${bounds.y}%`,
                width: `${bounds.width}%`,
                height: `${bounds.height}%`,
                pointerEvents: 'none',
              }}
            />
          );
        })}
        {placements.map(({ agent, room, left, top }) => (
          <Button
            key={agent.id}
            data-office-room={room}
            component="div"
            role="button"
            tabIndex={0}
            onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
              if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
              event.preventDefault();
              onSelect(agent.id);
            }}
            data-testid={`office-agent-${agent.id}`}
            data-agent-avatar={agent.id}
            aria-label={`${cast.get(agent.id)}: ${agent.title}, ${agent.state}`}
            aria-pressed={selectedId === agent.id}
            onClick={() => onSelect(agent.id)}
            variant="plain"
            title={`${cast.get(agent.id)}: ${agent.title} (${agent.state})`}
            sx={{
              position: 'absolute',
              left: `${left}%`,
              top: `${top}%`,
              // Same media key as the theme's Button transition, so this one merges over it instead of losing to it.
              '@media (prefers-reduced-motion: no-preference)': {
                transition: `left ${TRAVEL_MS}ms ease-in-out, top ${TRAVEL_MS}ms ease-in-out, background-color 120ms ease-out`,
              },
              pointerEvents: 'auto',
              p: 0,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 0,
              borderRadius: 0,
              background: selectedId === agent.id ? '#f4de8b33' : 'transparent',
              outline: selectedId === agent.id ? '2px solid #f4de8b' : undefined,
              '&:hover': { background: '#f4de8b33' },
              '&:focus-visible': { outline: '2px solid #f4de8b' },
              zIndex: 4,
            }}
          >
            <Box sx={{ display: 'flex' }}>
              <OfficeSprite
                name={cast.get(agent.id) ?? OFFICE_CAST[0]}
                resting={agent.state === 'done'}
                working={agent.state === 'working'}
                attention={agent.state === 'needs-you'}
              />
            </Box>
            <span
              style={{
                fontFamily: 'monospace',
                fontSize: 10,
                color: STATE_COLOR[agent.state],
                background: '#27382ded',
                padding: '2px 4px',
                whiteSpace: 'nowrap',
                borderBottom: `2px solid ${STATE_COLOR[agent.state]}`,
              }}
            >
              {cast.get(agent.id)?.split(' ')[0]}
              {agent.state === 'needs-you' ? ' !' : agent.state === 'done' ? ' *' : ''}
            </span>
            <AgentPrIndicator agentId={agent.id} pr={agent.pr} onOpen={() => onOpenPr?.(agent.id)} compact scene />
          </Button>
        ))}
        <Typography
          sx={{
            position: 'absolute',
            bottom: '.6%',
            left: 0,
            width: '100%',
            textAlign: 'center',
            color: '#c3c5a5',
            fontSize: 'clamp(8px, 1cqw, 11px)',
            fontFamily: 'monospace',
            pointerEvents: 'none',
          }}
        >
          {celebrating
            ? 'SHIFT COMPLETE. COFFEE IS ON THE MANAGER.'
            : 'Click Manager to talk. Select an employee to inspect their work.'}
        </Typography>
        {agentDetailsOverlay}
      </Box>
    </Box>
  );
}
