import { useMemo } from 'react';
import { Box, Button, Typography } from '@mui/joy';
import type { OrchestratorViewProps } from '../OrchestratorStage';
import { OFFICE_PARENT, assignOfficeCast } from './officeCast';
import { OFFICE_ROOMS, type OfficeRoom } from './officeLayout';
import { groupOfficeAgents } from './scene';
import { OfficeBackdrop } from './OfficeBackdrop';
import { OfficeSprite } from './OfficeSprite';

const ROOM_BOUNDS: Record<OfficeRoom, { x: number; y: number; width: number; height: number; columns: number }> = {
  reception: { x: 4, y: 56, width: 14, height: 14, columns: 2 },
  desks: { x: 23, y: 43, width: 28, height: 45, columns: 3 },
  'michael-door': { x: 17, y: 37, width: 33, height: 9, columns: 5 },
  'break-room': { x: 59, y: 21, width: 32, height: 25, columns: 4 },
  'conference-room': { x: 75, y: 57, width: 21, height: 32, columns: 3 },
};
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
  selectedId,
  onInnkeeperSelect,
  sceneOverlay,
  agentDetailsOverlay,
  desk,
  celebrating,
}: OrchestratorViewProps) {
  const cast = useMemo(() => assignOfficeCast(agents), [agents]);
  const rooms = useMemo(() => groupOfficeAgents(agents), [agents]);

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
          aria-label={`${OFFICE_PARENT}, parent session`}
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
          <OfficeSprite
            name={OFFICE_PARENT}
            resting={celebrating}
            working={parent?.status === 'processing'}
            attention={parent?.status === 'needs-action'}
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
            Michael Scott
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
              borderRadius: 0,
            }}
          >
            {desk.reply.snippet}
          </Button>
        )}
        {OFFICE_ROOMS.map(room => {
          const bounds = ROOM_BOUNDS[room.id];
          const members = rooms.get(room.id) ?? [];
          return (
            <Box
              key={room.id}
              component="section"
              aria-label={room.label}
              data-testid={`office-room-${room.id}`}
              sx={{
                position: 'absolute',
                left: `${bounds.x}%`,
                top: `${bounds.y}%`,
                width: `${bounds.width}%`,
                height: `${bounds.height}%`,
                pointerEvents: 'none',
              }}
            >
              {members.map((agent, index) => (
                <Button
                  key={agent.id}
                  data-testid={`office-agent-${agent.id}`}
                  data-agent-avatar={agent.id}
                  aria-label={`${cast.get(agent.id)}: ${agent.title}, ${agent.state}`}
                  aria-pressed={selectedId === agent.id}
                  onClick={() => onSelect(agent.id)}
                  variant="plain"
                  title={`${cast.get(agent.id)}: ${agent.title} (${agent.state})`}
                  sx={{
                    position: 'absolute',
                    left: `${(index % bounds.columns) * (100 / bounds.columns)}%`,
                    top: `${Math.floor(index / bounds.columns) * 43}%`,
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
                      name={cast.get(agent.id) ?? 'Jim Halpert'}
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
                </Button>
              ))}
            </Box>
          );
        })}
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
            ? 'SHIFT COMPLETE. COFFEE IS ON MICHAEL.'
            : 'Click Michael to talk. Select an employee to inspect their work.'}
        </Typography>
        {agentDetailsOverlay}
      </Box>
    </Box>
  );
}
