import Box from '@mui/joy/Box';
import { keyframes } from '@mui/system';
import { useEffect, useMemo, useRef, useState } from 'react';
import { activityLabel, toolKind, type ToolKind } from '../activity';
import { prefersReducedMotion } from '../motion';
import type { OrchestratorViewProps } from '../OrchestratorStage';
import { AGENT_STATE_LABEL, type AgentView } from '../roster';
import { DOOR_POINT, characterFor, placeAgents, poseFor, type Placement, type SlotPoint } from './scene';
import { TAVERN_BACKDROP, characterSprite } from './tavernArt';

const BUBBLE_MAX = 28;
const NAME_MAX = 18;
const WALK = '1.2s ease-in-out';
// Of the scene height, so sprites scale with the window; sprite canvases are square.
const SPRITE_HEIGHT = '15%';
const NO_MOTION = '@media (prefers-reduced-motion: reduce)';

const SPARK_COLOR: Record<ToolKind, string> = {
  edit: '#f28c28',
  read: '#3b82f6',
  shell: '#22c55e',
  web: '#a855f7',
  agent: '#ec4899',
  other: '#9ca3af',
};

const bob = keyframes`
  0% { transform: translateY(0); }
  50%, 100% { transform: translateY(-3%); }
`;

const twinkle = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
`;

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}\u2026` : text);

function bubbleText(agent: AgentView): string | undefined {
  if (agent.state === 'needs-you') return 'Needs you!';
  if (agent.state === 'working' && agent.activity) return truncate(activityLabel(agent.activity), BUBBLE_MAX);
  return undefined;
}

function sparkKind(agent: AgentView): ToolKind {
  const tool = agent.activity?.tool;
  return tool ? toolKind(tool) : 'other';
}

/** Keeps placements across renders so an agent whose zone is unchanged never hops to another seat. */
function usePlacements(agents: readonly AgentView[]) {
  const previous = useRef<ReadonlyMap<string, Placement>>(new Map());
  const placements = useMemo(() => placeAgents(agents, previous.current), [agents]);
  useEffect(() => {
    previous.current = placements;
  }, [placements]);
  return placements;
}

/** Flips to true two frames after mount (so the starting position is painted first), or at once if `already`. */
function useAfterFirstPaint(already: boolean) {
  const [done, setDone] = useState(already);
  useEffect(() => {
    if (done) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setDone(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [done]);
  return done;
}

/** During the intro everyone starts at the door and walks to their seats. Only the first mount plays it. */
const useArrived = (introPlaying: boolean) => useAfterFirstPaint(!introPlaying || prefersReducedMotion());

function Bubble({ agent, text }: { agent: AgentView; text: string }) {
  const urgent = agent.state === 'needs-you';
  return (
    <Box
      data-testid={`orchestrator-tavern-bubble-${agent.id}`}
      sx={{
        position: 'absolute',
        bottom: '88%',
        left: '50%',
        transform: 'translateX(-50%)',
        whiteSpace: 'nowrap',
        px: '0.6em',
        py: '0.25em',
        borderRadius: '6px',
        border: '2px solid #2a1d10',
        bgcolor: urgent ? '#f5c542' : 'rgba(255, 250, 240, 0.94)',
        color: '#2a1d10',
        fontSize: urgent ? 'clamp(11px, 2.8cqh, 18px)' : 'clamp(9px, 2.1cqh, 13px)',
        fontWeight: urgent ? 700 : 500,
        lineHeight: 1.2,
        pointerEvents: 'none',
      }}
    >
      {text}
    </Box>
  );
}

function Spark({ kind }: { kind: ToolKind }) {
  return (
    <Box
      aria-hidden
      sx={{
        position: 'absolute',
        top: '2%',
        right: '14%',
        display: 'flex',
        gap: '0.4cqh',
        animation: `${twinkle} 0.9s ease-in-out infinite`,
        [NO_MOTION]: { animation: 'none' },
      }}
    >
      {[0, 1, 2].map(dot => (
        <Box
          key={dot}
          sx={{
            width: '0.9cqh',
            height: '0.9cqh',
            minWidth: 3,
            minHeight: 3,
            bgcolor: SPARK_COLOR[kind],
            transform: dot === 1 ? 'translateY(-60%)' : undefined,
          }}
        />
      ))}
    </Box>
  );
}

function Sprite({
  agent,
  point,
  walkIn,
  selected,
  onSelect,
}: {
  agent: AgentView;
  point: SlotPoint;
  /** Mount at the door and walk to `point`; read on mount only. */
  walkIn: boolean;
  selected: boolean;
  onSelect(id: string): void;
}) {
  const entered = useAfterFirstPaint(!walkIn);
  const at = entered ? point : DOOR_POINT;
  const pose = poseFor(agent.state);
  const bubble = bubbleText(agent);
  return (
    <Box
      component="button"
      type="button"
      data-testid={`orchestrator-tavern-agent-${agent.id}`}
      aria-label={`${agent.title}: ${AGENT_STATE_LABEL[agent.state]}`}
      aria-pressed={selected}
      title={agent.title}
      onClick={() => onSelect(agent.id)}
      style={{ left: `${at.x}%`, top: `${at.y}%`, zIndex: Math.round(at.y) }}
      sx={{
        position: 'absolute',
        height: SPRITE_HEIGHT,
        aspectRatio: '1',
        transform: 'translate(-50%, -100%)',
        p: 0,
        border: 0,
        bgcolor: 'transparent',
        cursor: 'pointer',
        transition: `left ${WALK}, top ${WALK}`,
        [NO_MOTION]: { transition: 'none' },
        '&:focus-visible': { outline: '2px solid #f5c542', outlineOffset: 2, borderRadius: '4px' },
      }}
    >
      <Box
        component="img"
        src={characterSprite(characterFor(agent.id), pose)}
        alt=""
        draggable={false}
        sx={{
          display: 'block',
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated',
          filter: selected ? 'drop-shadow(0 0 3px #f5c542) drop-shadow(0 0 1px #f5c542)' : undefined,
          animation: pose === 'work' ? `${bob} 0.8s steps(1, end) infinite` : 'none',
          [NO_MOTION]: { animation: 'none' },
        }}
      />
      {agent.state === 'working' && <Spark kind={sparkKind(agent)} />}
      {bubble && <Bubble agent={agent} text={bubble} />}
      <Box
        sx={{
          position: 'absolute',
          top: '96%',
          left: '50%',
          transform: 'translateX(-50%)',
          whiteSpace: 'nowrap',
          px: '0.5em',
          borderRadius: '4px',
          bgcolor: 'rgba(20, 12, 6, 0.78)',
          color: '#fbe9c8',
          fontSize: 'clamp(9px, 1.9cqh, 12px)',
          lineHeight: 1.4,
          pointerEvents: 'none',
        }}
      >
        {truncate(agent.title, NAME_MAX)}
      </Box>
    </Box>
  );
}

export function TavernView({ agents, onSelect, selectedId, introPlaying }: OrchestratorViewProps) {
  const placements = usePlacements(agents);
  const arrived = useArrived(introPlaying);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);

  const queue = agents.filter(agent => placements.get(agent.id)?.zone === 'door');
  const selectedQueued = queue.findIndex(agent => agent.id === selectedId);
  // The door shows one agent: the selected one when it is queued, so the selection stays visible.
  const atDoor =
    selectedQueued >= 0
      ? queue[selectedQueued]
      : queue.reduce<AgentView | undefined>(
          (first, agent) =>
            !first || (placements.get(agent.id)?.slot ?? 0) < (placements.get(first.id)?.slot ?? 0) ? agent : first,
          undefined
        );
  const waiting = queue.length - 1;

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: '#140c06',
        containerType: 'size',
        overflow: 'hidden',
      }}
    >
      <Box
        data-testid="orchestrator-tavern"
        sx={{
          position: 'relative',
          width: 'min(100cqw, 100cqh * 16 / 9)',
          aspectRatio: '16 / 9',
          containerType: 'size',
          overflow: 'hidden',
        }}
      >
        <Box
          component="img"
          src={TAVERN_BACKDROP}
          alt=""
          draggable={false}
          sx={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            imageRendering: 'pixelated',
            opacity: arrived ? 1 : 0,
            transition: 'opacity 0.6s ease-in',
          }}
        />
        {agents.map(agent => {
          const placement = placements.get(agent.id);
          if (!placement || (placement.zone === 'door' && agent !== atDoor)) return null;
          return (
            <Sprite
              key={agent.id}
              agent={agent}
              point={arrived ? placement.point : DOOR_POINT}
              walkIn={mounted.current && !prefersReducedMotion()}
              selected={agent.id === selectedId}
              onSelect={onSelect}
            />
          );
        })}
        {waiting > 0 && (
          <Box
            component="button"
            type="button"
            data-testid="orchestrator-tavern-door-overflow"
            aria-label={`${waiting} more waiting at the door; select next`}
            onClick={() => onSelect(queue[(selectedQueued + 1) % queue.length].id)}
            style={{ left: `${DOOR_POINT.x}%`, top: `${DOOR_POINT.y}%` }}
            sx={{
              position: 'absolute',
              zIndex: 101,
              transform: 'translate(-50%, 20%)',
              px: '0.5em',
              py: 0,
              border: 0,
              borderRadius: '999px',
              cursor: 'pointer',
              bgcolor: '#f5c542',
              color: '#2a1d10',
              fontWeight: 700,
              fontSize: 'clamp(10px, 2.2cqh, 14px)',
              lineHeight: 1.5,
              '&:focus-visible': { outline: '2px solid #fbe9c8', outlineOffset: 2 },
            }}
          >
            {`+${waiting}`}
          </Box>
        )}
      </Box>
    </Box>
  );
}
