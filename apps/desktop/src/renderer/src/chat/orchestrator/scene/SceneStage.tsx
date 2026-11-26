import Box from '@mui/joy/Box';
import { useTheme } from '@mui/joy/styles';
import { keyframes } from '@mui/system';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { hashOf, type AgentPersona } from '@shared/agentPersona';
import { toolKind, type ToolKind } from '../activity';
import { AgentPrIndicator } from '../AgentPrIndicator';
import { prefersReducedMotion } from '../motion';
import type { OrchestratorViewProps } from '../OrchestratorStage';
import {
  AGENT_STATE_LABEL,
  describeAgentStates,
  spawnerName,
  type AgentState,
  type AgentView,
  type ParentView,
} from '../roster';
import { stateLampColor } from '../statePalette';
import { VISUALLY_HIDDEN } from '../../../visuallyHidden';
import { useAgentAnnouncements } from './announcements';
import { bubbleText, hostBubbleText, truncate } from './bubbleText';
import { AskBubble, type SpriteAsk } from './AskBubble';
import { assignSheets, hueFilter, type SceneArt } from './cast';
import { hostAct, hostBubble } from './host';
import { ReplyBubble } from './HostReply';
import { NeedsYouBubble } from './NeedsYouBubble';
import { OverflowStack, type StackedAgent } from './OverflowStack';
import { placeAgents, placementMap, type Placement } from './placement';
import { QuestBoard } from './QuestBoard';
import { useQuestNotes } from './quests';
import { SceneDialogue } from './SceneDialogue';
import { ASK_STATE_LABEL, sceneAskOf } from './sceneAsk';
import { useAskStates } from './useAskStates';
import type { HostPose, SceneDefinition, ScenePoint } from './sceneDefinition';
import { useSkinnedScene } from './sceneSkin';
import { SceneLight, type SceneMood } from './SceneLight';
import { LABEL_SPAN, hiddenBehind, nameLabelLayout, needsYouGroups, type NameLabel } from './stageGeometry';
import { useScenePause, type ScenePauseOptions } from './useScenePause';

const NAME_MAX = 26;
const WALK_MS = 1200;
const WALK = `${WALK_MS / 1000}s ease-in-out`;
const SPRITE_HEIGHT = 'var(--scene-sprite-height)';
const NO_MOTION = '@media (prefers-reduced-motion: reduce)';
// Pointing at, focusing or selecting an agent brings it forward and shows its label uncapped.
const LIFTED = '&:hover, &:focus-visible, &[aria-pressed="true"]';
// Above every seated sprite (zIndex is its y, at most 100) and the overflow stacks (101).
const LIFTED_Z = 102;
// Over the host's reply bubble (250) and under the order slip (300), which the user opened on purpose.
const ANSWER_BUBBLE_Z = 260;
const FOCUS_RING = { outline: '2px solid #f5c542', outlineOffset: 2, borderRadius: '4px' } as const;

type CssVars = CSSProperties & Record<`--${string}`, string | number>;
const HIDDEN_LABEL: NameLabel = { lane: 0, maxWidth: 0, shown: false };
const NO_PARENT: ParentView = {};
// Not a session id shape, so it never collides with an agent in the label layout.
const HOST_KEY = ' host';
const STACK_KEY = ' stack-';
const withPersona = (persona: { label: string } | undefined, title: string) =>
  persona ? `${persona.label}: ${title}` : title;
/** Shortest visit (ms): the walk over plus a moment beside the agent, however quick the read was. */
const VISIT_HOLD_MS = 2400;
/** How far beside a visited agent the host stands, toward the middle (percent of scene width). */
const VISIT_OFFSET = 4;

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

// The quiet room's slow camera: a breath of drift, small enough that the room's edges stay in frame.
const drift = keyframes`
  0%, 100% { transform: none; }
  50% { transform: scale(1.035) translate(-0.8%, 0.5%); }
`;

// There and back along the seat's reach (--roam-reach, cqw), easing at each end. `translate` composes
// with the sprite's own centring transform.
const roam = keyframes`
  0%, 100% { translate: calc(-1 * var(--roam-reach)) 0; }
  50% { translate: var(--roam-reach) 0; }
`;

// The art faces right, the way it swims out; it turns at the far end and swims back.
const faceTheWay = keyframes`
  0%, 49.9% { scale: 1 1; }
  50%, 100% { scale: -1 1; }
`;

type Roam = { reach: number; durationS: number; delayS: number };

/** One length per agent, out of step with the others, fixed by its id so a re-render never restarts it. */
function roamOf(id: string, reach: number): Roam {
  const hash = hashOf(id);
  const durationS = 22 + (hash % 13);
  return { reach, durationS, delayS: -((hash >>> 8) % durationS) };
}

const twinkle = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
`;

function sparkKind(agent: AgentView): ToolKind {
  const tool = agent.activity?.tool;
  return tool ? toolKind(tool) : 'other';
}

/** Keeps placements across renders so an agent whose zone is unchanged never hops to another seat. */
function usePlacements(agents: readonly AgentView[], scene: SceneDefinition) {
  const previous = useRef<ReadonlyMap<string, Placement>>(new Map());
  const map = useMemo(() => placementMap(scene), [scene]);
  const placements = useMemo(() => placeAgents(agents, previous.current, map), [agents, map]);
  useEffect(() => {
    previous.current = placements;
  }, [placements]);
  return { placements, previous: previous.current };
}

/** Recomputed only when the cast changes (ids, ages, epithets), not on every status tick. */
function useSheets(
  agents: readonly AgentView[],
  personas: ReadonlyMap<string, AgentPersona>,
  scene: SceneDefinition
): ReadonlyMap<string, number> {
  const subjects = agents.map(agent => ({
    id: agent.id,
    createdAt: agent.createdAt,
    epithet: personas.get(agent.id)?.epithet,
  }));
  const castKey = subjects.map(subject => `${subject.id}@${subject.createdAt}@${subject.epithet ?? ''}`).join('\n');
  const crafts = useMemo(() => scene.cast.sheets.map(sheet => sheet.craft), [scene]);
  // Keyed on the cast, not the roster's identity, which changes on every status tick.
  return useMemo(() => assignSheets(subjects, crafts), [castKey, crafts]);
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

function Bubble({
  testId,
  text,
  urgent,
  onHover = false,
  clickable = false,
}: {
  testId: string;
  text: string;
  urgent: boolean;
  /** Shown only while its sprite is hovered or focused. */
  onHover?: boolean;
  /** Takes the pointer, so a click on it reaches the sprite it hangs over. */
  clickable?: boolean;
}) {
  return (
    <Box
      data-testid={testId}
      data-hover-bubble={onHover || undefined}
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
        bgcolor: urgent ? stateLampColor('needs-you') : 'rgba(255, 250, 240, 0.94)',
        color: '#2a1d10',
        fontSize: urgent ? 'clamp(11px, 2.8cqh, 18px)' : 'clamp(9px, 2.1cqh, 13px)',
        fontWeight: urgent ? 700 : 500,
        lineHeight: 1.2,
        pointerEvents: clickable ? 'auto' : 'none',
        cursor: clickable ? 'pointer' : undefined,
        ...(onHover && { opacity: 0, transition: 'opacity 120ms ease-out' }),
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

/** The plate under a sprite naming it, in the scene's plate look; `state` adds its lamp. */
function NamePlate({
  testId,
  label,
  text,
  plate,
  state,
}: {
  testId: string;
  label: NameLabel;
  text: string;
  plate: SceneDefinition['look']['plate'];
  state?: AgentState;
}) {
  return (
    <Box
      data-testid={testId}
      data-name-label
      data-lane={label.lane}
      data-state={state}
      // cqw/cqh resolve against the scene box, the nearest size container.
      style={
        {
          '--label-max': `${label.maxWidth}cqw`,
          '--label-drop': `${label.lane * LABEL_SPAN}cqh`,
          '--lamp': state ? stateLampColor(state) : 'transparent',
        } as CssVars
      }
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
        background: plate.background,
        boxShadow: plate.edge,
        color: plate.ink,
        textShadow: '0 1px 0 #1f1208',
        fontSize: 'clamp(9px, 1.9cqh, 12px)',
        lineHeight: 1.4,
        pointerEvents: 'none',
        ...(state && {
          pl: '1.25em',
          '&::before': {
            content: '""',
            position: 'absolute',
            left: '0.45em',
            top: '50%',
            width: '0.45em',
            height: '0.45em',
            transform: 'translateY(-50%)',
            bgcolor: 'var(--lamp)',
            boxShadow: '0 0 4px var(--lamp)',
          },
        }),
      }}
    >
      {truncate(text, NAME_MAX)}
    </Box>
  );
}

/**
 * Holds an answerable bubble over a seat. It sits outside the sprite's own button (buttons cannot
 * nest) and above every sprite; near a wall it hangs inward so the scene's edge never clips it.
 */
function BubbleAnchor({ point, children }: { point: ScenePoint; children: ReactNode }) {
  const side =
    point.x < 25
      ? { left: '-1.5cqw' }
      : point.x > 75
        ? { right: '-1.5cqw' }
        : { left: 0, transform: 'translateX(-50%)' };
  return (
    <Box
      data-ambient-quiet
      style={{ left: `${point.x}%`, top: `${point.y}%` }}
      sx={{
        position: 'absolute',
        zIndex: ANSWER_BUBBLE_Z,
        width: 0,
        height: SPRITE_HEIGHT,
        transform: 'translateY(-100%)',
        pointerEvents: 'none',
      }}
    >
      <Box sx={{ position: 'absolute', bottom: '88%', width: 'max-content', ...side }}>{children}</Box>
    </Box>
  );
}

function Sprite({
  testId,
  agent,
  point,
  label,
  needsYou,
  ask,
  persona,
  art,
  animated,
  roam: swim,
  plate,
  via,
  walkFrom,
  selected,
  visited,
  cheering,
  onSelect,
  onOpenPr,
}: {
  testId: string;
  agent: AgentView;
  point: ScenePoint;
  label: NameLabel;
  /** How many waiting agents this sprite's bubble speaks for (needsYouGroups); 0 when another sprite carries it. */
  needsYou: number;
  /** The request its bubble shows in place of the bare "Needs you!", or how that request just ended. */
  ask: SpriteAsk | undefined;
  persona: AgentPersona | undefined;
  /** The agent's art in its current pose. */
  art: SceneArt;
  /** The pose bobs while held. */
  animated: boolean;
  /** The pose swims back and forth across its seat. */
  roam: Roam | undefined;
  plate: SceneDefinition['look']['plate'];
  /** The agent that spawned this one, below the first level; kept off the nameplate to keep it short. */
  via?: string;
  /** Mount here (the door, or the stack it waited in) and walk to `point`; read on mount only. */
  walkFrom: ScenePoint | undefined;
  selected: boolean;
  /** The host is checking on this agent but, under reduced motion, does not walk over. */
  visited: boolean;
  cheering: boolean;
  onSelect(id: string): void;
  onOpenPr?(id: string): void;
}) {
  const [start] = useState(walkFrom);
  const entered = useAfterFirstPaint(!start);
  const at = entered || !start ? point : start;
  const bubble = bubbleText(agent, needsYou);
  const displayName = persona?.label ?? agent.title;
  const viaSuffix = via ? ` \u00B7 via ${via}` : '';
  const fullName = `${withPersona(persona, agent.title)}${viaSuffix}`;
  const tooltip = `${persona ? `${persona.label}: ${persona.shortTitle}` : agent.title}${viaSuffix}`;
  return (
    <Box
      role="button"
      tabIndex={0}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onSelect(agent.id);
      }}
      data-testid={`${testId}-agent-${agent.id}`}
      data-agent-avatar={agent.id}
      aria-label={`${fullName}: ${AGENT_STATE_LABEL[agent.state]}`}
      aria-pressed={selected}
      data-host-visit={visited || undefined}
      data-cheering={cheering || undefined}
      title={tooltip}
      onClick={() => onSelect(agent.id)}
      style={
        {
          left: `${at.x}%`,
          top: `${at.y}%`,
          '--sprite-z': Math.round(at.y),
          ...(swim && { '--roam-reach': `${swim.reach}cqw` }),
        } as CssVars
      }
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
        // The whole button swims, so the click target, plate and bubble go with the art.
        animation: swim ? `${roam} ${swim.durationS}s ease-in-out ${swim.delayS}s infinite` : undefined,
        [NO_MOTION]: { transition: 'none', animation: 'none' },
        '&:focus-visible': FOCUS_RING,
        [LIFTED]: { zIndex: LIFTED_Z, '& [data-name-label]': { display: 'block', maxWidth: 'none' } },
      }}
    >
      <ContactShadow />
      <Box
        component="img"
        src={art.src}
        alt=""
        draggable={false}
        sx={{
          // Positioned so it paints over the ContactShadow before it.
          position: 'relative',
          display: 'block',
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated',
          filter:
            [
              hueFilter(art),
              selected || visited ? 'drop-shadow(0 0 3px #f5c542) drop-shadow(0 0 1px #f5c542)' : undefined,
            ]
              .filter(Boolean)
              .join(' ') || undefined,
          animation: [
            cheering ? `${cheer} 0.9s ease-in-out infinite` : animated ? `${bob} 0.8s steps(1, end) infinite` : 'none',
            swim && `${faceTheWay} ${swim.durationS}s linear ${swim.delayS}s infinite`,
          ]
            .filter(Boolean)
            .join(', '),
          [NO_MOTION]: { animation: 'none' },
        }}
      />
      {agent.state === 'working' && !agent.preparing && <Spark kind={sparkKind(agent)} />}
      {ask ? (
        <AskBubble testId={`${testId}-bubble-${agent.id}`} ask={ask} />
      ) : (
        bubble && (
          <Bubble
            testId={`${testId}-bubble-${agent.id}`}
            text={bubble}
            urgent={agent.state === 'needs-you'}
            clickable={agent.state === 'needs-you'}
          />
        )
      )}
      <NamePlate
        testId={`${testId}-name-${agent.id}`}
        label={label}
        text={displayName}
        plate={plate}
        state={agent.state}
      />
      {agent.pr && (
        <Box sx={{ position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)' }}>
          <AgentPrIndicator agentId={agent.id} pr={agent.pr} onOpen={() => onOpenPr?.(agent.id)} compact scene />
        </Box>
      )}
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

function standBeside(point: ScenePoint): ScenePoint {
  return { x: point.x + (point.x < 50 ? VISIT_OFFSET : -VISIT_OFFSET), y: point.y };
}

/** The parent conversation as a character: its pose, its status or greeting, and its walks to agents. */
function Host({
  testId,
  scene,
  point,
  pose,
  bubble,
  urgent,
  label,
  greeting,
  onSelect,
}: {
  testId: string;
  scene: SceneDefinition;
  point: ScenePoint;
  pose: HostPose;
  bubble: string | undefined;
  urgent: boolean;
  label: NameLabel;
  /** What it says when nothing else is on its mind: always, or only on hover. */
  greeting?: 'always' | 'hover';
  onSelect?(): void;
}) {
  const { copy } = scene;
  const { spriteHeight } = scene.cast;
  const { occluders } = scene.map;
  const hidden = hiddenBehind(point, spriteHeight, occluders);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const artRef = useRef<HTMLImageElement>(null);
  const walkedFrom = useRef(point);
  const rest = `inset(0 0 ${hidden}% 0)`;

  // The furniture overlap is not linear along a walk, so the clip follows the live position instead of easing.
  useLayoutEffect(() => {
    const from = walkedFrom.current;
    walkedFrom.current = point;
    const button = buttonRef.current;
    const art = artRef.current;
    const box = button?.parentElement;
    if (!button || !art || !box || (from.x === point.x && from.y === point.y) || prefersReducedMotion()) return;
    const follow = () => {
      const frame = box.getBoundingClientRect();
      if (frame.height <= 0) return;
      const feet = button.getBoundingClientRect();
      const live = {
        x: ((feet.left + feet.width / 2 - frame.left) / frame.width) * 100,
        y: ((feet.bottom - frame.top) / frame.height) * 100,
      };
      art.style.clipPath = `inset(0 0 ${hiddenBehind(live, spriteHeight, occluders)}% 0)`;
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
  }, [point.x, point.y, rest, spriteHeight, occluders]);

  return (
    <Box
      ref={buttonRef}
      component="button"
      type="button"
      disabled={!onSelect}
      data-behind-counter={hidden > 0 || undefined}
      tabIndex={onSelect ? undefined : -1}
      data-testid={`${testId}-host`}
      data-conversation-toggle
      data-pose={pose}
      aria-label={`${copy.hostName}: ${copy.hostPoses[pose]}`}
      title={`${copy.hostName}: ${copy.hostTitle}`}
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
        // Only the art takes the pointer: its clip-path keeps the part hidden behind furniture from being hit.
        pointerEvents: 'none',
        transition: `left ${WALK}, top ${WALK}`,
        [NO_MOTION]: { transition: 'none' },
        '&:focus-visible': FOCUS_RING,
        [LIFTED]: { zIndex: LIFTED_Z, '& [data-name-label]': { display: 'block', maxWidth: 'none' } },
        '&:hover [data-hover-bubble], &:focus-visible [data-hover-bubble]': { opacity: 1 },
      }}
    >
      <ContactShadow hidden={hidden > 0} />
      <Box
        component="img"
        src={scene.cast.host.sprites[pose]}
        alt=""
        draggable={false}
        ref={artRef}
        data-testid={`${testId}-host-art`}
        // The resting clip; while it walks the layout effect above overrides it frame by frame.
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
      {bubble ? (
        <Bubble testId={`${testId}-host-bubble`} text={hostBubbleText(bubble)} urgent={urgent} />
      ) : (
        greeting && (
          <Bubble
            testId={`${testId}-host-greeting`}
            text={copy.hostGreeting}
            urgent={false}
            onHover={greeting === 'hover'}
          />
        )
      )}
      <NamePlate testId={`${testId}-host-name`} label={label} text={copy.hostName} plate={scene.look.plate} />
    </Box>
  );
}

export type SceneStageProps = OrchestratorViewProps & {
  scene: SceneDefinition;
  /** When the scene holds still; defaults to pausing after a while unfocused, and always while hidden. */
  pause?: ScenePauseOptions;
  /** The "needs you" bubbles carry the answer buttons; off where another card already answers (the mini window). */
  answerFromBubble?: boolean;
};

/**
 * Draws any scene definition from the live roster, with every scene feature: seated sprites with name
 * plates, bubbles and PR badges, overflow stacks, the quest board, the host with its walks and reply
 * bubble, needs-you bubbles that answer in place or the dialogue box, lighting and the settled room,
 * the intro walk from the door, the finale's cheering, pause, reduced motion, and a live region. A
 * definition supplies the map, art, copy and look; it cannot switch a feature off. Test ids are
 * `orchestrator-<scene id>-...`, except the dialogue box's `scene-dialogue-*`.
 */
export function SceneStage({
  scene: definition,
  agents,
  onSelect,
  onOpenPr,
  selectedId,
  introPlaying,
  personas,
  parent = NO_PARENT,
  onInnkeeperSelect,
  celebrating = false,
  sceneOverlay,
  agentDetailsOverlay,
  desk,
  settled = false,
  pause,
  answerFromBubble = true,
  inSceneDecisions = false,
  needsYouFocusRequest,
}: SceneStageProps) {
  const scene = useSkinnedScene(definition);
  const { map, cast, states, copy, ambience, look } = scene;
  const testId = `orchestrator-${scene.id}`;
  const backdrop = map.backdrop;
  const mode = useTheme().palette.mode;
  const mood: SceneMood = settled ? 'last-call' : mode === 'dark' ? 'night' : 'day';
  const { placements, previous } = usePlacements(agents, scene);
  const sheets = useSheets(agents, personas, scene);
  const animatedPoses = useMemo(() => new Set(cast.animatedPoses), [cast]);
  const roamingPoses = useMemo(() => new Set(cast.roam?.poses), [cast]);
  const artOf = useCallback(
    (id: string, state: AgentState): SceneArt => {
      const sheet = cast.sheets[sheets.get(id) ?? 0];
      return { src: sheet.sprites[states.pose[state]], hue: sheet.hue };
    },
    [cast, sheets, states]
  );
  const arrived = useArrived(introPlaying);
  const act = hostAct(parent, agents);
  const heldVisit = useHeldVisit(act.pose === 'walking' ? act.target : undefined);
  // A visit held past its agent leaving the roster (archived, deleted) has nowhere to go.
  const visit = heldVisit !== undefined && placements.has(heldVisit) ? heldVisit : undefined;
  const reducedMotion = prefersReducedMotion();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);

  const visible = agents.flatMap(agent => {
    const placement = placements.get(agent.id);
    return placement?.kind === 'seat' ? [{ agent, placement }] : [];
  });
  // Drawn in a fixed order, not the roster's (which puts needs-you first): React would move a sprite whose
  // state changed, and a moved node drops its previous computed style, so it jumps to its seat instead of
  // walking. Tab and screen-reader order follow; the dialogue and needs-you strip surface waiting agents.
  const drawOrder = [...visible].sort((left, right) =>
    left.agent.id < right.agent.id ? -1 : left.agent.id > right.agent.id ? 1 : 0
  );
  const shortName = useCallback((agent: AgentView) => personas.get(agent.id)?.label ?? agent.title, [personas]);
  const stacks = new Map<string, { point: ScenePoint; stacked: StackedAgent[] }>();
  for (const agent of agents) {
    const placement = placements.get(agent.id);
    if (placement?.kind !== 'overflow') continue;
    const stack = stacks.get(placement.zone) ?? { point: placement.point, stacked: [] };
    stack.stacked[placement.index] = {
      agent,
      sprite: artOf(agent.id, agent.state),
      name: withPersona(personas.get(agent.id), agent.title),
    };
    stacks.set(placement.zone, stack);
  }
  const paused = useScenePause({ ...pause, awake: pause?.awake || ambience.awakeUnfocused === true });
  const quests = useQuestNotes(agents);
  const announcement = useAgentAnnouncements(agents, shortName);
  const summaryId = useId();
  const summary = describeAgentStates(
    agents.map(agent => agent.state),
    parent.status === 'needs-action' ? 1 : 0
  );
  // Laid out for where everyone stands once seated; labels may brush in passing while walking.
  const labels = nameLabelLayout(
    new Map([
      ...visible.map(({ agent, placement }) => [agent.id, placement.point] as const),
      [HOST_KEY, map.host] as const,
      // Stacks take no label, but name plates still keep clear of them.
      ...[...stacks].map(([zone, stack]) => [`${STACK_KEY}${zone}`, stack.point] as const),
    ])
  );
  const needsYouGroupsByCarrier = needsYouGroups(
    visible
      .filter(({ agent }) => agent.state === 'needs-you')
      .map(({ agent, placement }) => ({ id: agent.id, zone: placement.zone, point: placement.point }))
  );
  const needsYou = new Map([...needsYouGroupsByCarrier].map(([id, group]) => [id, group.length]));
  // One place to answer: with the dialogue box up, a waiting sprite's bubble shows its request and state but
  // answers in the box.
  // It stays up at last call too, when someone away from the keyboard is most likely to come back to it.
  const dialogue = inSceneDecisions && answerFromBubble;
  // Until everyone is seated the bubble rides inside the walking sprite; after that it stands on its own with buttons.
  const answerBubbles =
    answerFromBubble && arrived && !dialogue ? needsYouGroupsByCarrier : new Map<string, string[]>();
  const agentsById = new Map(agents.map(agent => [agent.id, agent]));
  const [dialogueFront, setDialogueFront] = useState<string | undefined>(undefined);
  const [dialogueFocus, setDialogueFocus] = useState(0);
  const { asks: dialogueAsks, outcomes, onAsksChange, onAnswered } = useAskStates(dialogue, agents);
  const spriteAskOf = (agent: AgentView, count: number): SpriteAsk | undefined => {
    const ended = outcomes.get(agent.id);
    if (ended) return { heading: ASK_STATE_LABEL[ended.state], state: ended.state, ask: ended.ask };
    const decision = dialogue && agent.state === 'needs-you' && count > 0 ? dialogueAsks.get(agent.id) : undefined;
    if (!decision) return undefined;
    return { heading: bubbleText(agent, count) ?? 'Needs you!', state: 'waiting', ask: sceneAskOf(decision) };
  };
  // A waiting character, clicked, brings its request to the front of the box instead of opening its details.
  // Needs-you with nothing the box can answer (no parked call) opens the details, so the click is never dead.
  const selectSprite = (id: string) => {
    if (dialogue && agentsById.get(id)?.state === 'needs-you' && dialogueAsks.has(id)) {
      setDialogueFront(id);
      setDialogueFocus(value => value + 1);
    } else onSelect(id);
  };
  // The needs-you zone's bubble sits on the line of the host's plate at every stage size, so the plate
  // steps aside while it is up; pointing at the host still shows it (LIFTED).
  const callingZone = states.zone['needs-you'];
  const zoneCalling = visible.some(({ agent, placement }) => placement.zone === callingZone && needsYou.has(agent.id));
  const hostLabel = labels.get(HOST_KEY) ?? HIDDEN_LABEL;
  const [dismissedReply, setDismissedReply] = useState<string | undefined>(undefined);
  const statusBubble = hostBubble(parent);
  // Only while the conversation is hidden: with the dock open the reply is already in plain sight.
  const reply =
    desk?.reply &&
    desk.conversationHidden &&
    !statusBubble &&
    // An answerable bubble at the needs-you zone sits where the reply would; the reply waits until it is answered.
    !(zoneCalling && answerBubbles.size > 0) &&
    desk.reply.id !== dismissedReply
      ? desk.reply
      : undefined;

  const visitedPoint = visit === undefined ? undefined : placements.get(visit)?.point;
  const hostPoint = visitedPoint && !reducedMotion && arrived ? standBeside(visitedPoint) : map.host;
  const walkStart = (before: Placement | undefined) => (before?.kind === 'overflow' ? before.point : map.door);

  return (
    // The scene is a framed picture on the page surface rather than a dark band edge to edge, so the
    // composer below sits on the same surface as the margin around it instead of cutting the scene off.
    <Box
      data-testid={`${testId}-frame`}
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
        transition: 'padding 0.8s ease-in-out, background-color 0.8s ease-in-out',
        containerType: 'size',
        overflow: 'hidden',
        [NO_MOTION]: { transition: 'none' },
        // Nobody is looking: hold every looping animation (embers, flicker, bob, drift) where it is.
        '&[data-paused] *, &[data-paused] *::before, &[data-paused] *::after': {
          animationPlayState: 'paused !important',
        },
      }}
    >
      <Box id={summaryId} data-testid={`${testId}-summary`} sx={VISUALLY_HIDDEN}>
        {summary}
      </Box>
      <Box data-testid={`${testId}-announcer`} aria-live="polite" aria-atomic sx={VISUALLY_HIDDEN}>
        <span key={announcement.key}>{announcement.text}</span>
      </Box>
      {/* Quiet, the room spills past its frame: a soft, dim copy of it fills the bars around the picture. */}
      <Box
        aria-hidden
        data-testid={`${testId}-spill`}
        sx={{
          position: 'absolute',
          inset: '-6%',
          backgroundImage: `url("${backdrop}")`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          filter: 'blur(28px) brightness(0.45) saturate(1.2)',
          opacity: settled ? 1 : 0,
          transition: 'opacity 1.6s ease-in-out',
          pointerEvents: 'none',
          [NO_MOTION]: { transition: 'none' },
        }}
      />
      <Box
        data-testid={testId}
        role="group"
        aria-label={copy.name}
        // Focusable only by script: where focus lands when an overflow stack it was in goes away.
        tabIndex={-1}
        aria-describedby={summaryId}
        style={{ '--scene-sprite-height': `${cast.spriteHeight}%` } as CssVars}
        sx={{
          position: 'relative',
          width: `min(100cqw, 100cqh * ${map.aspect.width} / ${map.aspect.height})`,
          anchorName: '--orchestrator-scene',
          aspectRatio: `${map.aspect.width} / ${map.aspect.height}`,
          containerType: 'size',
          overflow: 'hidden',
          borderRadius: settled ? 0 : 'lg',
          bgcolor: ambience.floor,
          boxShadow: settled ? ambience.settledShadow : 'md',
          outline: settled ? 'none' : '1px solid',
          outlineColor: 'divider',
          transition: 'border-radius 0.8s ease-in-out, box-shadow 1.6s ease-in-out',
          animation: settled && ambience.settledDrift ? `${drift} 120s ease-in-out infinite` : 'none',
          [NO_MOTION]: { transition: 'none', animation: 'none' },
        }}
      >
        <Box
          component="img"
          src={backdrop}
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
        {ambience.veil && (
          <Box
            aria-hidden
            data-testid={`${testId}-veil`}
            sx={{ position: 'absolute', inset: 0, bgcolor: ambience.veil, pointerEvents: 'none' }}
          />
        )}
        <QuestBoard
          testId={`${testId}-quest`}
          board={map.board}
          plate={look.plate}
          copy={copy.board}
          notes={quests}
          name={shortName}
          selectedId={selectedId}
          onSelect={onSelect}
          onOpenPr={onOpenPr}
        />
        <SceneLight testId={`${testId}-light`} mood={mood} map={map} />
        {drawOrder.map(({ agent, placement }) => (
          <Sprite
            key={agent.id}
            testId={testId}
            agent={agent}
            point={arrived ? placement.point : map.door}
            label={labels.get(agent.id) ?? HIDDEN_LABEL}
            needsYou={answerBubbles.has(agent.id) ? 0 : (needsYou.get(agent.id) ?? 0)}
            ask={answerBubbles.has(agent.id) ? undefined : spriteAskOf(agent, needsYou.get(agent.id) ?? 0)}
            persona={personas.get(agent.id)}
            art={artOf(agent.id, agent.state)}
            animated={animatedPoses.has(states.pose[agent.state])}
            roam={
              cast.roam && roamingPoses.has(states.pose[agent.state]) ? roamOf(agent.id, cast.roam.reach) : undefined
            }
            plate={look.plate}
            via={spawnerName(agent, agents, spawner => personas.get(spawner.id)?.label ?? spawner.title)}
            walkFrom={mounted.current && !prefersReducedMotion() ? walkStart(previous.get(agent.id)) : undefined}
            selected={agent.id === selectedId}
            visited={reducedMotion && agent.id === visit}
            cheering={celebrating}
            onSelect={selectSprite}
            onOpenPr={onOpenPr}
          />
        ))}
        {[...answerBubbles].map(([carrierId, group]) => {
          const point = placements.get(carrierId)?.point;
          const waiting = group.flatMap(id => agentsById.get(id) ?? []);
          if (!point || waiting.length === 0) return null;
          return (
            <BubbleAnchor key={carrierId} point={point}>
              <NeedsYouBubble
                testId={`${testId}-bubble-${carrierId}`}
                waiting={waiting}
                nameOf={shortName}
                onOpen={onSelect}
              />
            </BubbleAnchor>
          );
        })}
        <Host
          testId={testId}
          scene={scene}
          point={hostPoint}
          pose={celebrating ? 'cheering' : visit ? 'walking' : act.pose}
          bubble={statusBubble}
          urgent={parent.status === 'needs-action'}
          label={zoneCalling ? { ...hostLabel, shown: false } : hostLabel}
          greeting={!desk || reply ? undefined : agents.length === 0 ? 'always' : 'hover'}
          onSelect={onInnkeeperSelect}
        />
        {desk && reply && (
          <ReplyBubble
            testId={testId}
            anchor={map.reply}
            board={map.board}
            snippet={reply.snippet}
            onReadAll={() => {
              setDismissedReply(reply.id);
              desk.onReadReply(reply.id);
            }}
            onDismiss={() => setDismissedReply(reply.id)}
          />
        )}
        {[...stacks].map(([zone, stack]) => (
          <OverflowStack
            key={zone}
            testId={testId}
            zone={zone}
            place={map.zones[zone].place}
            faceY={cast.faceY}
            point={stack.point}
            stacked={stack.stacked}
            selectedId={selectedId}
            onSelect={onSelect}
            onOpenPr={onOpenPr}
          />
        ))}
        {dialogue && (
          <SceneDialogue
            agents={agents}
            nameOf={id => {
              const agent = agentsById.get(id);
              return agent ? shortName(agent) : id;
            }}
            portraitOf={id => artOf(id, 'needs-you')}
            frontKey={dialogueFront}
            onFrontChange={setDialogueFront}
            onAsksChange={onAsksChange}
            onAnswered={onAnswered}
            onOpenDetails={onSelect}
            focusRequest={dialogueFocus + (needsYouFocusRequest ?? 0)}
            look={mode === 'dark' ? 'wood' : 'parchment'}
          />
        )}
        {sceneOverlay}
        {agentDetailsOverlay}
      </Box>
    </Box>
  );
}

type SceneViewOptions = { pause?: ScenePauseOptions; answerFromBubble?: boolean };

const SCENE_VIEWS = new WeakMap<object, { scene: SceneDefinition; options: SceneViewOptions }>();

/** A registry entry for a scene: the view the stage mounts, built from data alone. */
export function sceneView(scene: SceneDefinition, options: SceneViewOptions = {}) {
  const { pause, answerFromBubble } = options;
  function SceneView(props: OrchestratorViewProps) {
    return <SceneStage {...props} scene={scene} pause={pause} answerFromBubble={answerFromBubble} />;
  }
  SceneView.displayName = `SceneView(${scene.id})`;
  SCENE_VIEWS.set(SceneView, { scene, options });
  return SceneView;
}

/** The definition and options a view was built with by `sceneView`, or undefined for any other component. */
export function sceneViewOf(view: unknown): { scene: SceneDefinition; options: SceneViewOptions } | undefined {
  return typeof view === 'function' ? SCENE_VIEWS.get(view) : undefined;
}
