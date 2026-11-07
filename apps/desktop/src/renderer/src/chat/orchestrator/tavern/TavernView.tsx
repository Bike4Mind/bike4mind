import Box from '@mui/joy/Box';
import { keyframes } from '@mui/system';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { SESSION_SETUP_LABEL } from '@shared/chat';
import { activityLabel, toolKind, type ToolKind } from '../activity';
import { prefersReducedMotion } from '../motion';
import type { OrchestratorViewProps } from '../OrchestratorStage';
import { AGENT_STATE_LABEL, spawnerName, type AgentView, type ParentView } from '../roster';
import type { AgentPersona } from '@shared/agentPersona';
import { innkeeperAct, innkeeperBubble } from './innkeeper';
import {
  DOOR_POINT,
  INNKEEPER_POINT,
  LABEL_SPAN,
  characterFor,
  nameLabelLayout,
  hiddenByCounter,
  placeAgents,
  poseFor,
  type NameLabel,
  type Placement,
  type SlotPoint,
} from './scene';
import { INNKEEPER_ART, TAVERN_BACKDROP, characterSprite, type InnkeeperPose } from './tavernArt';

const BUBBLE_MAX = 28;
const NAME_MAX = 26;
const WALK_MS = 1200;
const WALK = `${WALK_MS / 1000}s ease-in-out`;
// Percent of the scene height, so sprites scale with the window; sprite canvases are square.
const SPRITE_HEIGHT_PERCENT = 15;
const SPRITE_HEIGHT = `${SPRITE_HEIGHT_PERCENT}%`;
const NO_MOTION = '@media (prefers-reduced-motion: reduce)';
// Pointing at, focusing or selecting an agent brings it forward and shows its label uncapped.
const LIFTED = '&:hover, &:focus-visible, &[aria-pressed="true"]';
// Above every seated sprite (zIndex is its y, at most 100) and the door overflow chip.
const LIFTED_Z = 102;

type CssVars = CSSProperties & Record<`--${string}`, string | number>;
const HIDDEN_LABEL: NameLabel = { lane: 0, maxWidth: 0, shown: false };
const NO_PARENT: ParentView = {};
// Not a session id shape, so it never collides with an agent in the label layout.
const INNKEEPER_KEY = ' innkeeper';
const INNKEEPER_NAME = 'Innkeeper';
/** Shortest visit (ms): the walk over plus a moment beside the agent, however quick the read was. */
const VISIT_HOLD_MS = 2400;
/** How far beside a visited agent the Innkeeper stands, toward the middle (percent of scene width). */
const VISIT_OFFSET = 4;

const INNKEEPER_POSE_LABEL: Record<InnkeeperPose, string> = {
  idle: 'Polishing the bar',
  writing: 'Posting quests',
  reading: 'Reading the reports',
  walking: 'Checking on an agent',
  cheering: 'Cheering',
};

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

// A mug raised: hop up, hold, drop.
const cheer = keyframes`
  0%, 100% { transform: translateY(0); }
  30%, 60% { transform: translateY(-12%); }
`;

const twinkle = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
`;

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}\u2026` : text);

function bubbleText(agent: AgentView): string | undefined {
  if (agent.state === 'needs-you') return 'Needs you!';
  if (agent.state === 'working' && agent.preparing) return `${SESSION_SETUP_LABEL[agent.preparing]}\u2026`;
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

function Bubble({ testId, text, urgent }: { testId: string; text: string; urgent: boolean }) {
  return (
    <Box
      data-testid={testId}
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

/**
 * The soft patch of floor under a sprite's feet that keeps it from reading as pasted on. Rendered
 * before the art so the sprite paints over it; the art's feet sit at the bottom centre of its box.
 */
function ContactShadow({ hidden = false }: { hidden?: boolean }) {
  return (
    <Box
      aria-hidden
      data-contact-shadow
      sx={{
        position: 'absolute',
        left: '50%',
        bottom: 0,
        width: '48%',
        height: '9%',
        transform: 'translate(-50%, 40%)',
        borderRadius: '50%',
        background: 'radial-gradient(closest-side, rgba(14, 7, 2, 0.6), rgba(14, 7, 2, 0))',
        opacity: hidden ? 0 : 1,
        transition: `opacity ${WALK}`,
        pointerEvents: 'none',
        [NO_MOTION]: { transition: 'none' },
      }}
    />
  );
}

function NameLabelPlate({ testId, label, text }: { testId: string; label: NameLabel; text: string }) {
  return (
    <Box
      data-testid={testId}
      data-name-label
      data-lane={label.lane}
      // cqw/cqh resolve against the scene box, the nearest size container.
      style={{ '--label-max': `${label.maxWidth}cqw`, '--label-drop': `${label.lane * LABEL_SPAN}cqh` } as CssVars}
      sx={{
        display: label.shown ? 'block' : 'none',
        position: 'absolute',
        top: 'calc(96% + var(--label-drop))',
        maxWidth: 'var(--label-max)',
        maxHeight: `${LABEL_SPAN}cqh`,
        left: '50%',
        transform: 'translateX(-50%)',
        boxSizing: 'border-box',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
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
      {truncate(text, NAME_MAX)}
    </Box>
  );
}

function Sprite({
  agent,
  point,
  label,
  persona,
  via,
  walkIn,
  selected,
  visited,
  cheering,
  onSelect,
}: {
  agent: AgentView;
  point: SlotPoint;
  label: NameLabel;
  persona: AgentPersona | undefined;
  /** The agent that spawned this one, below the first level; kept off the nameplate to keep it short. */
  via?: string;
  /** Mount at the door and walk to `point`; read on mount only. */
  walkIn: boolean;
  selected: boolean;
  /** The Innkeeper is checking on this agent but, under reduced motion, does not walk over. */
  visited: boolean;
  cheering: boolean;
  onSelect(id: string): void;
}) {
  const entered = useAfterFirstPaint(!walkIn);
  const at = entered ? point : DOOR_POINT;
  const pose = poseFor(agent.state);
  const bubble = bubbleText(agent);
  const displayName = persona?.label ?? agent.title;
  const viaSuffix = via ? ` \u00B7 via ${via}` : '';
  const fullName = `${persona ? `${persona.label}: ${agent.title}` : agent.title}${viaSuffix}`;
  const tooltip = `${persona ? `${persona.label}: ${persona.shortTitle}` : agent.title}${viaSuffix}`;
  return (
    <Box
      component="button"
      type="button"
      data-testid={`orchestrator-tavern-agent-${agent.id}`}
      aria-label={`${fullName}: ${AGENT_STATE_LABEL[agent.state]}`}
      aria-pressed={selected}
      data-innkeeper-visit={visited || undefined}
      data-cheering={cheering || undefined}
      title={tooltip}
      onClick={() => onSelect(agent.id)}
      style={{ left: `${at.x}%`, top: `${at.y}%`, '--sprite-z': Math.round(at.y) } as CssVars}
      sx={{
        position: 'absolute',
        zIndex: 'var(--sprite-z)',
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
        [LIFTED]: { zIndex: LIFTED_Z, '& [data-name-label]': { display: 'block', maxWidth: 'none' } },
      }}
    >
      <ContactShadow />
      <Box
        component="img"
        src={characterSprite(characterFor(agent.id, persona?.epithet), pose)}
        alt=""
        draggable={false}
        sx={{
          // Positioned so it paints over the ContactShadow before it.
          position: 'relative',
          display: 'block',
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated',
          filter: selected || visited ? 'drop-shadow(0 0 3px #f5c542) drop-shadow(0 0 1px #f5c542)' : undefined,
          animation: cheering
            ? `${cheer} 0.9s ease-in-out infinite`
            : pose === 'work'
              ? `${bob} 0.8s steps(1, end) infinite`
              : 'none',
          [NO_MOTION]: { animation: 'none' },
        }}
      />
      {agent.state === 'working' && !agent.preparing && <Spark kind={sparkKind(agent)} />}
      {bubble && (
        <Bubble testId={`orchestrator-tavern-bubble-${agent.id}`} text={bubble} urgent={agent.state === 'needs-you'} />
      )}
      <NameLabelPlate testId={`orchestrator-tavern-name-${agent.id}`} label={label} text={displayName} />
    </Box>
  );
}

/** Holds a visit for at least VISIT_HOLD_MS, so a read that returns at once still gets its walk. */
function useHeldVisit(target: string | undefined): string | undefined {
  const [held, setHeld] = useState(target);
  const since = useRef(0);
  useEffect(() => {
    if (target !== undefined) {
      if (target !== held) since.current = Date.now();
      setHeld(target);
      return;
    }
    if (held === undefined) return;
    const timer = window.setTimeout(() => setHeld(undefined), Math.max(0, since.current + VISIT_HOLD_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [target, held]);
  return held;
}

function standBeside(point: SlotPoint): SlotPoint {
  return { x: point.x + (point.x < 50 ? VISIT_OFFSET : -VISIT_OFFSET), y: point.y };
}

function Innkeeper({
  point,
  pose,
  bubble,
  urgent,
  label,
  onSelect,
}: {
  point: SlotPoint;
  pose: InnkeeperPose;
  bubble: string | undefined;
  urgent: boolean;
  label: NameLabel;
  onSelect?(): void;
}) {
  const hidden = hiddenByCounter(point, SPRITE_HEIGHT_PERCENT);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const artRef = useRef<HTMLImageElement>(null);
  const walkedFrom = useRef(point);
  const rest = `inset(0 0 ${hidden}% 0)`;

  // The counter overlap is not linear along a walk, so the clip follows his live position instead of easing.
  useLayoutEffect(() => {
    const from = walkedFrom.current;
    walkedFrom.current = point;
    const button = buttonRef.current;
    const art = artRef.current;
    const scene = button?.parentElement;
    if (!button || !art || !scene || (from.x === point.x && from.y === point.y) || prefersReducedMotion()) return;
    const follow = () => {
      const box = scene.getBoundingClientRect();
      if (box.height <= 0) return;
      const feet = button.getBoundingClientRect();
      const live = {
        x: ((feet.left + feet.width / 2 - box.left) / box.width) * 100,
        y: ((feet.bottom - box.top) / box.height) * 100,
      };
      art.style.clipPath = `inset(0 0 ${hiddenByCounter(live, SPRITE_HEIGHT_PERCENT)}% 0)`;
    };
    let start: number | undefined;
    let frame = 0;
    const tick = (now: number) => {
      start ??= now;
      if (now - start >= WALK_MS) {
        art.style.clipPath = rest;
        return;
      }
      follow();
      frame = requestAnimationFrame(tick);
    };
    follow();
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // Keyed on the coordinates: a re-render with an equal point must not cancel a walk in progress.
  }, [point.x, point.y, rest]);

  return (
    <Box
      ref={buttonRef}
      component="button"
      type="button"
      disabled={!onSelect}
      data-behind-counter={hidden > 0 || undefined}
      tabIndex={onSelect ? undefined : -1}
      data-testid="orchestrator-tavern-innkeeper"
      data-pose={pose}
      aria-label={`${INNKEEPER_NAME}: ${INNKEEPER_POSE_LABEL[pose]}`}
      title={`${INNKEEPER_NAME}: the conversation that posts the quests`}
      onClick={onSelect}
      style={{ left: `${point.x}%`, top: `${point.y}%`, '--sprite-z': Math.round(point.y) } as CssVars}
      sx={{
        position: 'absolute',
        zIndex: 'var(--sprite-z)',
        height: SPRITE_HEIGHT,
        aspectRatio: '1',
        transform: 'translate(-50%, -100%)',
        p: 0,
        border: 0,
        bgcolor: 'transparent',
        // Only the art takes the pointer: its clip-path keeps the part hidden behind the counter from being hit.
        pointerEvents: 'none',
        transition: `left ${WALK}, top ${WALK}`,
        [NO_MOTION]: { transition: 'none' },
        '&:focus-visible': { outline: '2px solid #f5c542', outlineOffset: 2, borderRadius: '4px' },
        [LIFTED]: { zIndex: LIFTED_Z, '& [data-name-label]': { display: 'block', maxWidth: 'none' } },
      }}
    >
      <ContactShadow hidden={hidden > 0} />
      <Box
        component="img"
        src={INNKEEPER_ART[pose]}
        alt=""
        draggable={false}
        ref={artRef}
        data-testid="orchestrator-tavern-innkeeper-art"
        // The resting clip; while he walks the layout effect above overrides it frame by frame.
        style={{ clipPath: rest }}
        sx={{
          position: 'relative',
          display: 'block',
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated',
          pointerEvents: 'auto',
          cursor: onSelect ? 'pointer' : 'default',
        }}
      />
      {bubble && (
        <Bubble testId="orchestrator-tavern-innkeeper-bubble" text={truncate(bubble, BUBBLE_MAX)} urgent={urgent} />
      )}
      <NameLabelPlate testId="orchestrator-tavern-innkeeper-name" label={label} text={INNKEEPER_NAME} />
    </Box>
  );
}

export function TavernView({
  agents,
  onSelect,
  selectedId,
  introPlaying,
  personas,
  parent = NO_PARENT,
  onInnkeeperSelect,
  celebrating = false,
  sceneOverlay,
}: OrchestratorViewProps) {
  const placements = usePlacements(agents);
  const arrived = useArrived(introPlaying);
  const act = innkeeperAct(parent, agents);
  const heldVisit = useHeldVisit(act.pose === 'walking' ? act.target : undefined);
  // A visit held past its agent leaving the roster (archived, deleted) has nowhere to go.
  const visit = heldVisit !== undefined && placements.has(heldVisit) ? heldVisit : undefined;
  const reducedMotion = prefersReducedMotion();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);

  const queue = agents.filter(agent => placements.get(agent.id)?.zone === 'door');
  const selectedQueued = queue.findIndex(agent => agent.id === selectedId);
  const firstQueued = (candidates: readonly AgentView[]) =>
    candidates.reduce<AgentView | undefined>(
      (first, agent) =>
        !first || (placements.get(agent.id)?.slot ?? 0) < (placements.get(first.id)?.slot ?? 0) ? agent : first,
      undefined
    );
  // The door shows one agent: the selected one so the selection stays visible, else one that needs the
  // user so the bar overflowing never hides a call for help, else the longest-queued.
  const atDoor =
    selectedQueued >= 0
      ? queue[selectedQueued]
      : (firstQueued(queue.filter(agent => agent.state === 'needs-you')) ?? firstQueued(queue));
  const waiting = queue.length - 1;
  const hiddenNeedsYou = queue.filter(agent => agent !== atDoor && agent.state === 'needs-you').length;
  const urgent = hiddenNeedsYou > 0;
  const urgentNote = urgent ? `, ${hiddenNeedsYou} ${hiddenNeedsYou === 1 ? 'needs' : 'need'} you` : '';
  const visible = agents.flatMap(agent => {
    const placement = placements.get(agent.id);
    return placement && (placement.zone !== 'door' || agent === atDoor) ? [{ agent, placement }] : [];
  });
  // Laid out for where everyone stands once seated; labels may brush in passing while walking.
  const labels = nameLabelLayout(
    new Map([
      ...visible.map(({ agent, placement }) => [agent.id, placement.point] as const),
      [INNKEEPER_KEY, INNKEEPER_POINT] as const,
    ])
  );
  const visitedPoint = visit === undefined ? undefined : placements.get(visit)?.point;
  const innkeeperPoint = visitedPoint && !reducedMotion && arrived ? standBeside(visitedPoint) : INNKEEPER_POINT;

  return (
    // The scene is a framed picture on the page surface rather than a dark band edge to edge, so the
    // composer below sits on the same surface as the margin around it instead of cutting the scene off.
    <Box
      data-testid="orchestrator-tavern-frame"
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 1.5,
        bgcolor: 'background.body',
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
          borderRadius: 'lg',
          bgcolor: '#140c06',
          boxShadow: 'md',
          outline: '1px solid',
          outlineColor: 'divider',
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
        {visible.map(({ agent, placement }) => (
          <Sprite
            key={agent.id}
            agent={agent}
            point={arrived ? placement.point : DOOR_POINT}
            label={labels.get(agent.id) ?? HIDDEN_LABEL}
            persona={personas.get(agent.id)}
            via={spawnerName(agent, agents, spawner => personas.get(spawner.id)?.label ?? spawner.title)}
            walkIn={mounted.current && !prefersReducedMotion()}
            selected={agent.id === selectedId}
            visited={reducedMotion && agent.id === visit}
            cheering={celebrating}
            onSelect={onSelect}
          />
        ))}
        <Innkeeper
          point={innkeeperPoint}
          pose={celebrating ? 'cheering' : visit ? 'walking' : act.pose}
          bubble={innkeeperBubble(parent)}
          urgent={parent.status === 'needs-action'}
          label={labels.get(INNKEEPER_KEY) ?? HIDDEN_LABEL}
          onSelect={onInnkeeperSelect}
        />
        {waiting > 0 && (
          <Box
            component="button"
            type="button"
            data-testid="orchestrator-tavern-door-overflow"
            aria-label={`${waiting} more waiting at the door${urgentNote}; select next`}
            onClick={() => {
              const next = selectedQueued >= 0 ? queue[(selectedQueued + 1) % queue.length] : atDoor;
              if (next) onSelect(next.id);
            }}
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
              bgcolor: urgent ? '#f5c542' : 'rgba(20, 12, 6, 0.78)',
              color: urgent ? '#2a1d10' : '#fbe9c8',
              fontWeight: 700,
              fontSize: 'clamp(10px, 2.2cqh, 14px)',
              lineHeight: 1.5,
              '&:focus-visible': { outline: '2px solid #fbe9c8', outlineOffset: 2 },
            }}
          >
            {`${urgent ? '!' : ''}+${waiting}`}
          </Box>
        )}
        {sceneOverlay}
      </Box>
    </Box>
  );
}
