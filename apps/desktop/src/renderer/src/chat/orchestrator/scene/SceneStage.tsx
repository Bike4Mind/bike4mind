import Box from '@mui/joy/Box';
import Dropdown from '@mui/joy/Dropdown';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import { keyframes } from '@mui/system';
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { AgentPersona } from '@shared/agentPersona';
import { AgentPrIndicator } from '../AgentPrIndicator';
import type { OrchestratorViewProps } from '../OrchestratorStage';
import { AGENT_STATE_LABEL, describeAgentStates, type AgentView, type ParentView } from '../roster';
import { stateLampColor } from '../statePalette';
import { VISUALLY_HIDDEN } from '../../../visuallyHidden';
import { assignSheets } from './cast';
import { placeAgents, placementMap, type Placement } from './placement';
import type { SceneDefinition, ScenePoint } from './sceneDefinition';
import { useScenePause, type ScenePauseOptions } from './useScenePause';

const WALK = '1.2s ease-in-out';
const NO_MOTION = '@media (prefers-reduced-motion: reduce)';
// Seated sprites take their y (0-100) as zIndex; stacks sit above them and a lifted sprite above both.
const STACK_Z = 101;
const LIFTED_Z = 102;
const LIFTED = '&:hover, &:focus-visible, &[aria-pressed="true"]';
const FOCUS_RING = { outline: '2px solid #f5c542', outlineOffset: 2, borderRadius: '4px' };
const NO_PARENT: ParentView = {};

type CssVars = CSSProperties & Record<`--${string}`, string | number>;

const bob = keyframes`
  0% { transform: translateY(0); }
  50%, 100% { transform: translateY(-3%); }
`;

const cheer = keyframes`
  0%, 100% { transform: translateY(0); }
  30%, 60% { transform: translateY(-12%); }
`;

const flicker = keyframes`
  0%, 100% { opacity: 1; }
  45% { opacity: 0.82; }
  70% { opacity: 0.92; }
`;

const drift = keyframes`
  0%, 100% { transform: none; }
  50% { transform: scale(1.035) translate(-0.8%, 0.5%); }
`;

/** Keeps placements across renders so an agent whose zone is unchanged never hops to another seat. */
function usePlacements(agents: readonly AgentView[], scene: SceneDefinition) {
  const previous = useRef<ReadonlyMap<string, Placement>>(new Map());
  const map = useMemo(() => placementMap(scene), [scene]);
  const placements = useMemo(() => placeAgents(agents, previous.current, map), [agents, map]);
  useEffect(() => {
    previous.current = placements;
  }, [placements]);
  return placements;
}

/** Recomputed only when the cast changes (ids, ages, epithets), not on every status tick. */
function useSheets(
  agents: readonly AgentView[],
  personas: ReadonlyMap<string, AgentPersona>,
  scene: SceneDefinition
): ReadonlyMap<string, number> {
  const castKey = agents
    .map(agent => `${agent.id}@${agent.createdAt}@${personas.get(agent.id)?.epithet ?? ''}`)
    .join('\n');
  const crafts = useMemo(() => scene.cast.sheets.map(sheet => sheet.craft), [scene]);
  return useMemo(
    () =>
      assignSheets(
        agents.map(agent => ({ id: agent.id, createdAt: agent.createdAt, epithet: personas.get(agent.id)?.epithet })),
        crafts
      ),
    // Keyed on the cast, not the roster's identity, which changes on every status tick.
    [castKey, crafts]
  );
}

const nameOf = (agent: AgentView, persona: AgentPersona | undefined) =>
  persona ? `${persona.label}: ${agent.title}` : agent.title;

interface SpriteProps {
  agent: AgentView;
  point: ScenePoint;
  name: string;
  src: string;
  animated: boolean;
  cheering: boolean;
  selected: boolean;
  onSelect(id: string): void;
  onOpenPr?(id: string): void;
}

const SceneSprite = memo(function SceneSprite({
  agent,
  point,
  name,
  src,
  animated,
  cheering,
  selected,
  onSelect,
  onOpenPr,
}: SpriteProps) {
  return (
    <Box
      role="button"
      tabIndex={0}
      data-testid={`scene-stage-agent-${agent.id}`}
      data-agent-avatar={agent.id}
      data-state={agent.state}
      aria-label={`${name}: ${AGENT_STATE_LABEL[agent.state]}`}
      aria-pressed={selected}
      title={name}
      onClick={() => onSelect(agent.id)}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onSelect(agent.id);
      }}
      style={{ left: `${point.x}%`, top: `${point.y}%`, '--sprite-z': Math.round(point.y) } as CssVars}
      sx={{
        position: 'absolute',
        zIndex: 'var(--sprite-z)',
        height: 'var(--scene-sprite-height)',
        aspectRatio: '1',
        transform: 'translate(-50%, -100%)',
        cursor: 'pointer',
        transition: `left ${WALK}, top ${WALK}`,
        [NO_MOTION]: { transition: 'none' },
        '&:focus-visible': FOCUS_RING,
        [LIFTED]: { zIndex: LIFTED_Z },
      }}
    >
      <Box
        aria-hidden
        data-scene-lamp
        style={{ '--lamp': stateLampColor(agent.state) } as CssVars}
        sx={{
          position: 'absolute',
          left: '50%',
          bottom: 0,
          width: '40%',
          height: '8%',
          transform: 'translate(-50%, 40%)',
          borderRadius: '50%',
          bgcolor: 'var(--lamp)',
          boxShadow: '0 0 6px var(--lamp)',
          opacity: 0.75,
        }}
      />
      <Box
        component="img"
        src={src}
        alt=""
        draggable={false}
        sx={{
          position: 'relative',
          display: 'block',
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated',
          filter: selected ? 'drop-shadow(0 0 3px #f5c542) drop-shadow(0 0 1px #f5c542)' : undefined,
          animation: cheering
            ? `${cheer} 0.9s ease-in-out infinite`
            : animated
              ? `${bob} 0.8s steps(1, end) infinite`
              : 'none',
          [NO_MOTION]: { animation: 'none' },
        }}
      />
      {agent.pr && (
        <Box sx={{ position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)' }}>
          <AgentPrIndicator agentId={agent.id} pr={agent.pr} onOpen={() => onOpenPr?.(agent.id)} compact scene />
        </Box>
      )}
    </Box>
  );
});

type Stacked = { agent: AgentView; name: string };

/** A full zone's extra agents: one button with a count, opening a menu of every agent in it. */
function OverflowPile({
  zone,
  place,
  point,
  stacked,
  selectedId,
  onSelect,
}: {
  zone: string;
  place: string;
  point: ScenePoint;
  stacked: readonly Stacked[];
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  const needing = stacked.filter(({ agent }) => agent.state === 'needs-you').length;
  const needsYou = needing > 0 ? `, ${needing} ${needing === 1 ? 'needs' : 'need'} you` : '';
  const holdsSelection = stacked.some(({ agent }) => agent.id === selectedId);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The pile goes once its last agent takes a seat, open menu and all; keep focus in the scene, not on body.
  useLayoutEffect(
    () => () => {
      const focused = document.activeElement;
      const scene = buttonRef.current?.parentElement;
      if (!focused || !scene) return;
      if (buttonRef.current?.contains(focused) || menuRef.current?.contains(focused)) scene.focus();
    },
    []
  );
  return (
    <Dropdown>
      <MenuButton
        ref={buttonRef}
        data-testid={`scene-stage-overflow-${zone}`}
        data-agent-avatar={holdsSelection ? (selectedId ?? undefined) : undefined}
        data-urgent={needing > 0 || undefined}
        aria-label={`${stacked.length} more ${place}${needsYou}; list them`}
        variant="soft"
        size="sm"
        style={{ left: `${point.x}%`, top: `${point.y}%` }}
        sx={{
          position: 'absolute',
          zIndex: STACK_Z,
          transform: 'translate(-50%, -100%)',
          minHeight: 0,
          px: '0.6em',
          fontSize: 'clamp(10px, 2.2cqh, 14px)',
          ...(needing > 0 && { bgcolor: stateLampColor('needs-you'), color: '#2a1d10' }),
        }}
      >
        +{stacked.length}
      </MenuButton>
      <Menu
        ref={menuRef}
        size="sm"
        placement="top"
        sx={{ maxHeight: 280, overflowY: 'auto', zIndex: 'var(--joy-zIndex-popup)' }}
      >
        {stacked.map(({ agent, name }) => (
          <MenuItem
            key={agent.id}
            data-testid={`scene-stage-overflow-item-${agent.id}`}
            selected={agent.id === selectedId}
            onClick={() => onSelect(agent.id)}
          >
            <Box
              aria-hidden
              sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, bgcolor: stateLampColor(agent.state) }}
            />
            {`${name}: ${AGENT_STATE_LABEL[agent.state]}`}
          </MenuItem>
        ))}
      </Menu>
    </Dropdown>
  );
}

export type SceneStageProps = OrchestratorViewProps & {
  scene: SceneDefinition;
  /** When the scene holds still; defaults to pausing after a while unfocused, and always while hidden. */
  pause?: ScenePauseOptions;
};

/**
 * Draws any scene definition from the live roster: the backdrop and lights, one sprite per seated agent,
 * an overflow stack per full zone, and the host. The framework owns placement, keyboard and aria, the PR
 * indicator, where agent details hang, pause and reduced motion; a definition only supplies data.
 */
export function SceneStage({
  scene,
  agents,
  personas,
  selectedId,
  onSelect,
  onOpenPr,
  parent = NO_PARENT,
  onInnkeeperSelect,
  celebrating = false,
  settled = false,
  sceneOverlay,
  agentDetailsOverlay,
  pause,
}: SceneStageProps) {
  const placements = usePlacements(agents, scene);
  const sheets = useSheets(agents, personas, scene);
  const paused = useScenePause(pause);
  const summaryId = useId();
  const animatedPoses = useMemo(() => new Set(scene.cast.animatedPoses), [scene]);
  const { map, cast, states, copy, ambience } = scene;

  const seated: { agent: AgentView; point: ScenePoint }[] = [];
  const stacks = new Map<string, { point: ScenePoint; stacked: Stacked[] }>();
  for (const agent of agents) {
    const placement = placements.get(agent.id);
    if (!placement) continue;
    if (placement.kind === 'seat') {
      seated.push({ agent, point: placement.point });
      continue;
    }
    const stack = stacks.get(placement.zone) ?? { point: placement.point, stacked: [] };
    stack.stacked[placement.index] = { agent, name: nameOf(agent, personas.get(agent.id)) };
    stacks.set(placement.zone, stack);
  }
  const summary = describeAgentStates(
    agents.map(agent => agent.state),
    parent.status === 'needs-action' ? 1 : 0
  );
  const hostPose = celebrating ? 'cheering' : 'idle';

  return (
    <Box
      data-testid="scene-stage-frame"
      data-scene={scene.id}
      data-settled={settled || undefined}
      data-paused={paused}
      sx={{
        position: 'relative',
        flex: 1,
        minHeight: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: settled ? 0 : 1.5,
        bgcolor: settled ? ambience.frame : 'background.body',
        containerType: 'size',
        overflow: 'hidden',
        transition: 'padding 0.8s ease-in-out, background-color 0.8s ease-in-out',
        [NO_MOTION]: { transition: 'none' },
        '&[data-paused] *, &[data-paused] *::before, &[data-paused] *::after': {
          animationPlayState: 'paused !important',
        },
      }}
    >
      <Box id={summaryId} data-testid="scene-stage-summary" sx={VISUALLY_HIDDEN}>
        {summary}
      </Box>
      <Box
        data-testid="scene-stage"
        role="group"
        aria-label={copy.name}
        aria-describedby={summaryId}
        tabIndex={-1}
        style={{ '--scene-sprite-height': `${cast.spriteHeight}%` } as CssVars}
        sx={{
          position: 'relative',
          width: `min(100cqw, 100cqh * ${map.aspect.width} / ${map.aspect.height})`,
          aspectRatio: `${map.aspect.width} / ${map.aspect.height}`,
          anchorName: '--orchestrator-scene',
          containerType: 'size',
          overflow: 'hidden',
          borderRadius: settled ? 0 : 'lg',
          bgcolor: ambience.floor,
          boxShadow: 'md',
          outline: settled ? 'none' : '1px solid',
          outlineColor: 'divider',
          animation: settled && ambience.settledDrift ? `${drift} 120s ease-in-out infinite` : 'none',
          [NO_MOTION]: { animation: 'none' },
        }}
      >
        <Box
          component="img"
          src={map.backdrop}
          alt=""
          draggable={false}
          sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', imageRendering: 'pixelated' }}
        />
        {map.lights.map((light, index) => (
          <Box
            key={index}
            aria-hidden
            data-scene-light
            style={{
              left: `${light.x}%`,
              top: `${light.y}%`,
              width: `${light.size * 2}cqw`,
              background: `radial-gradient(closest-side, ${light.color}, transparent)`,
            }}
            sx={{
              position: 'absolute',
              aspectRatio: '1',
              transform: 'translate(-50%, -50%)',
              mixBlendMode: 'screen',
              opacity: 0.55,
              pointerEvents: 'none',
              animation: light.flicker ? `${flicker} 2.4s ease-in-out infinite` : 'none',
              [NO_MOTION]: { animation: 'none' },
            }}
          />
        ))}
        {seated.map(({ agent, point }) => (
          <SceneSprite
            key={agent.id}
            agent={agent}
            point={point}
            name={nameOf(agent, personas.get(agent.id))}
            src={cast.sheets[sheets.get(agent.id) ?? 0].sprites[states.pose[agent.state]]}
            animated={animatedPoses.has(states.pose[agent.state])}
            cheering={celebrating}
            selected={agent.id === selectedId}
            onSelect={onSelect}
            onOpenPr={onOpenPr}
          />
        ))}
        {[...stacks].map(([zone, stack]) => (
          <OverflowPile
            key={zone}
            zone={zone}
            place={map.zones[zone].place}
            point={stack.point}
            stacked={stack.stacked}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ))}
        <Box
          component="button"
          type="button"
          data-testid="scene-stage-host"
          data-pose={hostPose}
          disabled={!onInnkeeperSelect}
          tabIndex={onInnkeeperSelect ? undefined : -1}
          aria-label={copy.hostName}
          title={`${copy.hostName}: ${copy.hostTitle}`}
          onClick={onInnkeeperSelect}
          style={{ left: `${map.host.x}%`, top: `${map.host.y}%`, '--sprite-z': Math.round(map.host.y) } as CssVars}
          sx={{
            position: 'absolute',
            zIndex: 'var(--sprite-z)',
            height: 'var(--scene-sprite-height)',
            aspectRatio: '1',
            transform: 'translate(-50%, -100%)',
            p: 0,
            border: 0,
            bgcolor: 'transparent',
            cursor: onInnkeeperSelect ? 'pointer' : 'default',
            '&:focus-visible': FOCUS_RING,
          }}
        >
          <Box
            component="img"
            src={cast.host.sprites[hostPose]}
            alt=""
            draggable={false}
            sx={{
              display: 'block',
              width: '100%',
              height: '100%',
              imageRendering: 'pixelated',
              animation: celebrating ? `${cheer} 0.9s ease-in-out infinite` : 'none',
              [NO_MOTION]: { animation: 'none' },
            }}
          />
        </Box>
        {sceneOverlay}
        {agentDetailsOverlay}
      </Box>
    </Box>
  );
}

/** A registry entry for a scene: the view the stage mounts, built from data alone. */
export function sceneView(scene: SceneDefinition, { pause }: { pause?: ScenePauseOptions } = {}) {
  function SceneView(props: OrchestratorViewProps) {
    return <SceneStage {...props} scene={scene} pause={pause} />;
  }
  SceneView.displayName = `SceneView(${scene.id})`;
  return SceneView;
}
