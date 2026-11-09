import type { AgentState, AgentView } from '../roster';
import type { Epithet } from '@shared/agentPersona';
import type { CharacterId, Pose } from './tavernArt';

export type TavernZone = 'workbench' | 'bar' | 'hearth' | 'benches' | 'door';

/** Percent of the scene box (0-100), where the sprite's feet stand. */
export interface SlotPoint {
  x: number;
  y: number;
}

type SeatZone = Exclude<TavernZone, 'door'>;

// Tied to assets/orchestrator/tavern/backdrop.png: re-pick these if the backdrop is regenerated.
export const TAVERN_SLOTS: Record<SeatZone, readonly SlotPoint[]> = {
  workbench: [
    { x: 13, y: 46 },
    { x: 25, y: 46 },
    { x: 37, y: 46 },
    { x: 10, y: 55 },
    { x: 22, y: 55 },
    { x: 34, y: 55 },
  ],
  bar: [
    { x: 53, y: 45 },
    { x: 59, y: 45 },
    { x: 65, y: 45 },
    { x: 71, y: 45 },
  ],
  // A sprite is about 5% of the scene wide, so neighbours sit at least 7% apart or a row lower.
  hearth: [
    { x: 70, y: 52 },
    { x: 78, y: 60 },
    { x: 87, y: 62 },
    { x: 94, y: 68 },
  ],
  benches: [
    { x: 20, y: 64 },
    { x: 29, y: 64 },
    { x: 38, y: 64 },
    { x: 52, y: 68 },
    { x: 61, y: 68 },
    { x: 70, y: 68 },
  ],
};

export const DOOR_POINT: SlotPoint = { x: 4, y: 46 };

/**
 * The bar counter as drawn in the backdrop (percent of the scene box): `top` is where its top
 * meets the shelving behind it, `front` where its front panel meets the floor.
 */
export const BAR_COUNTER = { left: 45, right: 77, top: 26.3, front: 38 } as const;

/** Behind the bar counter, above the stools, so the Innkeeper never takes an agent's seat. */
export const INNKEEPER_POINT: SlotPoint = { x: 62, y: 30.5 };

/**
 * How much of a sprite standing at `point` the counter hides, as a percent of its box from the
 * bottom. Feet behind the counter stand on floor the backdrop never shows, so everything below
 * the counter top is cut away; anywhere else the sprite is whole and stands on visible floor.
 */
export function hiddenByCounter(point: SlotPoint, spriteHeight: number): number {
  const behind = point.x >= BAR_COUNTER.left && point.x <= BAR_COUNTER.right && point.y < BAR_COUNTER.front;
  if (!behind) return 0;
  return Math.min(100, Math.max(0, ((point.y - BAR_COUNTER.top) / spriteHeight) * 100));
}

const ZONE: Record<AgentState, SeatZone> = {
  working: 'workbench',
  'needs-you': 'bar',
  done: 'hearth',
  failed: 'benches',
  stopped: 'benches',
  idle: 'benches',
};

const POSE: Record<AgentState, Pose> = {
  working: 'work',
  'needs-you': 'call',
  done: 'rest',
  failed: 'ko',
  stopped: 'idle',
  idle: 'idle',
};

export function zoneFor(state: AgentState): SeatZone {
  return ZONE[state];
}

export function poseFor(state: AgentState): Pose {
  return POSE[state];
}

// Wanderer is absent on purpose: with no craft to show it keeps the id-based pick, so the fallback
// epithet does not turn the roster into clones of one sprite.
const EPITHET_CHARACTER: Partial<Record<Epithet, CharacterId>> = {
  Warden: 3,
  Scribe: 2,
  Seeker: 2,
  Tinkerer: 4,
  Cartographer: 1,
};

export function characterFor(agentId: string, epithet?: Epithet): CharacterId {
  const byCraft = epithet ? EPITHET_CHARACTER[epithet] : undefined;
  if (byCraft) return byCraft;
  let hash = 0;
  for (let index = 0; index < agentId.length; index++) hash = (hash * 31 + agentId.charCodeAt(index)) >>> 0;
  return ((hash % 4) + 1) as CharacterId;
}

/** For the door, `slot` is the agent's index in the queue and `point` is always `DOOR_POINT`. */
export type Placement = { zone: TavernZone; point: SlotPoint; slot: number };

/**
 * Seats agents so nobody shuffles needlessly: an agent whose zone is unchanged keeps its previous slot,
 * the rest take the lowest free slot in their zone, and whoever finds the zone full queues at the door.
 * The door remembers too: an agent still queued keeps its index, newcomers take the lowest free index in
 * roster order, so indices can have gaps.
 */
export function placeAgents(
  agents: readonly AgentView[],
  previous: ReadonlyMap<string, Placement>
): Map<string, Placement> {
  const taken: Record<SeatZone, Set<number>> = {
    workbench: new Set(),
    bar: new Set(),
    hearth: new Set(),
    benches: new Set(),
  };
  const placements = new Map<string, Placement>();

  for (const agent of agents) {
    const zone = zoneFor(agent.state);
    const before = previous.get(agent.id);
    if (!before || before.zone !== zone || taken[zone].has(before.slot)) continue;
    taken[zone].add(before.slot);
    placements.set(agent.id, { zone, point: TAVERN_SLOTS[zone][before.slot], slot: before.slot });
  }

  const unseated: AgentView[] = [];
  for (const agent of agents) {
    if (placements.has(agent.id)) continue;
    const zone = zoneFor(agent.state);
    const free = TAVERN_SLOTS[zone].findIndex((_, slot) => !taken[zone].has(slot));
    if (free < 0) {
      unseated.push(agent);
      continue;
    }
    taken[zone].add(free);
    placements.set(agent.id, { zone, point: TAVERN_SLOTS[zone][free], slot: free });
  }

  const queue = new Set<number>();
  const newcomers: AgentView[] = [];
  for (const agent of unseated) {
    const before = previous.get(agent.id);
    if (before?.zone !== 'door' || queue.has(before.slot)) {
      newcomers.push(agent);
      continue;
    }
    queue.add(before.slot);
    placements.set(agent.id, { zone: 'door', point: DOOR_POINT, slot: before.slot });
  }
  let next = 0;
  for (const agent of newcomers) {
    while (queue.has(next)) next++;
    queue.add(next);
    placements.set(agent.id, { zone: 'door', point: DOOR_POINT, slot: next });
  }
  return placements;
}

/**
 * A name label's height cap and the drop of its second line, as a percent of scene height. Labels
 * whose tops are at least this far apart can never meet.
 */
export const LABEL_SPAN = 4.5;
/** Widest a name label gets, as a percent of scene width. */
export const NAME_LABEL_MAX_WIDTH = 16;
/** Below this width (percent of scene width) a label would show only an ellipsis, so it is not drawn. */
export const NAME_LABEL_MIN_WIDTH = 4;
const LABEL_GUTTER = 0.5;

/** `lane` 1 drops the label one LABEL_SPAN below its usual line; `maxWidth` is a percent of scene width. */
export type NameLabel = { lane: 0 | 1; maxWidth: number; shown: boolean };

type LaidOut = { point: SlotPoint; lane: 0 | 1 };

/** Widest a label at `point` on `lane` can be without meeting any of `others`, all centred under their points. */
function labelCap(point: SlotPoint, lane: 0 | 1, others: Iterable<LaidOut>): number {
  const top = point.y + lane * LABEL_SPAN;
  let cap = NAME_LABEL_MAX_WIDTH;
  for (const other of others) {
    if (Math.abs(other.point.y + other.lane * LABEL_SPAN - top) >= LABEL_SPAN) continue;
    cap = Math.min(cap, Math.abs(other.point.x - point.x) - LABEL_GUTTER);
  }
  return Math.max(0, cap);
}

/**
 * Lays out the name labels so no two drawn ones overlap at rest. Left to right, each label takes the
 * line (its own, or one span lower) that leaves it wider, which staggers alternate neighbours in a
 * crowded row; then each is capped to its gap to every label it shares a line with. All in scene
 * units, so it holds at any stage size.
 */
export function nameLabelLayout(points: ReadonlyMap<string, SlotPoint>): Map<string, NameLabel> {
  const lanes = new Map<string, LaidOut>();
  const leftToRight = [...points].sort(([, a], [, b]) => a.x - b.x || a.y - b.y);
  for (const [id, point] of leftToRight) {
    const placed = [...lanes.values()];
    const lane = labelCap(point, 1, placed) > labelCap(point, 0, placed) ? 1 : 0;
    lanes.set(id, { point, lane });
  }

  const layout = new Map<string, NameLabel>();
  for (const [id, point] of points) {
    const own = lanes.get(id);
    if (!own) continue;
    const others = [...lanes].filter(([otherId]) => otherId !== id).map(([, other]) => other);
    const maxWidth = labelCap(point, own.lane, others);
    layout.set(id, { lane: own.lane, maxWidth, shown: maxWidth >= NAME_LABEL_MIN_WIDTH });
  }
  return layout;
}
