import { byAge, hashOf, type Epithet } from '@shared/agentPersona';
import type { AgentState, AgentView } from '../roster';
import { CHARACTER_COUNT, characterCraft, type CharacterId, type Pose } from './tavernArt';
import { TAVERN_LAYOUT } from './tavernLayout';

/** Where an agent sits, by state; the door is only where newcomers walk in from. */
export type TavernZone = 'workbench' | 'bar' | 'hearth' | 'benches';

/** Percent of the scene box (0-100), where the sprite's feet stand. */
export interface SlotPoint {
  x: number;
  y: number;
}

// Coordinates live in assets/orchestrator/tavern/layout.json, beside the backdrop they are picked for.
export const TAVERN_SLOTS: Record<TavernZone, readonly SlotPoint[]> = TAVERN_LAYOUT.slots;

/** Where a full zone stacks the agents it has no seat for. */
export const OVERFLOW_POINTS: Record<TavernZone, SlotPoint> = TAVERN_LAYOUT.overflow;

export const DOOR_POINT: SlotPoint = TAVERN_LAYOUT.door;

/** The quest board's box on the back wall (percent of the scene box) and how many notes it holds. */
export const QUEST_BOARD = TAVERN_LAYOUT.questBoard;

/**
 * Splits `items` into the notes pinned on a board with room for `capacity`, and the rest. Like a full
 * zone's overflow stack, a board that cannot fit everything gives its last place to a "+N" note.
 */
export function pinNotes<T>(items: readonly T[], capacity: number): { pinned: T[]; hidden: T[] } {
  if (items.length <= capacity) return { pinned: [...items], hidden: [] };
  const room = Math.max(0, capacity - 1);
  return { pinned: items.slice(0, room), hidden: items.slice(room) };
}

/**
 * The bar counter as drawn in the backdrop (percent of the scene box): `top` is where its top
 * meets the shelving behind it, `front` where its front panel meets the floor.
 */
export const BAR_COUNTER = TAVERN_LAYOUT.barCounter;

/** Behind the bar counter, above the stools, so the Innkeeper never takes an agent's seat. */
export const INNKEEPER_POINT: SlotPoint = TAVERN_LAYOUT.innkeeper;

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

const ZONE: Record<AgentState, TavernZone> = {
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

/** The lamp on each nameplate and token: the agent's state at a glance, without the bubble. */
export const STATE_LAMP: Record<AgentState, string> = {
  'needs-you': '#f5c542',
  working: '#ff9d3c',
  done: '#7ed07a',
  failed: '#e5534b',
  stopped: '#a89a88',
  idle: '#a89a88',
};

export function zoneFor(state: AgentState): TavernZone {
  return ZONE[state];
}

export function poseFor(state: AgentState): Pose {
  return POSE[state];
}

/** What a character is chosen from: the agent's id, its age (oldest choose first) and its kind of work. */
export type CastSubject = { id: string; createdAt: string; epithet?: Epithet };

/**
 * Gives every agent a character sheet, a pure function of the roster so it survives reloads. Oldest
 * first, each agent takes a sheet nobody has yet, preferring one whose craft matches its epithet and
 * otherwise walking the cast from a point picked by its id hash. Only once every sheet is in use does
 * a sheet repeat, and then a fresh round starts so repeats spread evenly.
 */
export function assignCharacters(
  agents: readonly CastSubject[],
  count: number = CHARACTER_COUNT,
  craftOf: (character: CharacterId) => Epithet = characterCraft
): Map<string, CharacterId> {
  const taken = new Set<CharacterId>();
  const characters = new Map<string, CharacterId>();
  for (const agent of [...agents].sort(byAge)) {
    if (taken.size >= count) taken.clear();
    const start = hashOf(agent.id) % count;
    const free = Array.from({ length: count }, (_, step) => ((start + step) % count) + 1).filter(
      character => !taken.has(character)
    );
    const character = free.find(candidate => agent.epithet && craftOf(candidate) === agent.epithet) ?? free[0];
    if (character === undefined) throw new Error('assignCharacters: empty cast');
    taken.add(character);
    characters.set(agent.id, character);
  }
  return characters;
}

/**
 * A `seat` is one of the zone's slots; `borrowed` marks a needs-you agent seated outside the full bar.
 * An `overflow` agent has no seat and waits, `index`-th, in its zone's stack at OVERFLOW_POINTS.
 */
export type Placement =
  | { kind: 'seat'; zone: TavernZone; slot: number; point: SlotPoint; borrowed: boolean }
  | { kind: 'overflow'; zone: TavernZone; index: number; point: SlotPoint };

// Where a needs-you agent sits once the bar is full: the benches face the bar, the hearth is furthest.
const BORROW_ORDER: readonly TavernZone[] = ['benches', 'workbench', 'hearth'];

/**
 * Seats agents so nobody shuffles needlessly: an agent whose zone is unchanged keeps its previous slot,
 * the rest take the lowest free slot in their zone, and whoever finds the zone full joins that zone's
 * overflow stack in roster order. A needs-you agent is never stacked while any seat could hold it: it
 * borrows a free seat elsewhere, and failing that takes the seat of the last calm agent in the roster,
 * who goes to its own zone's stack instead.
 */
export function placeAgents(
  agents: readonly AgentView[],
  previous: ReadonlyMap<string, Placement>
): Map<string, Placement> {
  const taken: Record<TavernZone, Set<number>> = {
    workbench: new Set(),
    bar: new Set(),
    hearth: new Set(),
    benches: new Set(),
  };
  const placements = new Map<string, Placement>();
  const seat = (agent: AgentView, zone: TavernZone, slot: number) => {
    taken[zone].add(slot);
    placements.set(agent.id, {
      kind: 'seat',
      zone,
      slot,
      point: TAVERN_SLOTS[zone][slot],
      borrowed: zone !== zoneFor(agent.state),
    });
  };
  const freeSlot = (zone: TavernZone) => TAVERN_SLOTS[zone].findIndex((_, slot) => !taken[zone].has(slot));

  const seatAtHome = (agent: AgentView) => {
    const zone = zoneFor(agent.state);
    const free = freeSlot(zone);
    if (free >= 0) seat(agent, zone, free);
    return free >= 0;
  };

  for (const agent of agents) {
    const before = previous.get(agent.id);
    if (before?.kind !== 'seat' || taken[before.zone].has(before.slot)) continue;
    if (before.zone === zoneFor(agent.state)) seat(agent, before.zone, before.slot);
  }

  // A freed bar seat beats a borrowed one; a borrowed seat is kept over newcomers to its zone.
  for (const agent of agents) {
    if (agent.state !== 'needs-you' || placements.has(agent.id) || seatAtHome(agent)) continue;
    const before = previous.get(agent.id);
    if (before?.kind === 'seat' && before.borrowed && !taken[before.zone].has(before.slot)) {
      seat(agent, before.zone, before.slot);
    }
  }

  const unseated: AgentView[] = [];
  for (const agent of agents) {
    if (placements.has(agent.id)) continue;
    if (agent.state === 'needs-you' || !seatAtHome(agent)) unseated.push(agent);
  }

  const stacked = new Set(unseated.filter(agent => agent.state !== 'needs-you').map(agent => agent.id));
  for (const agent of unseated) {
    if (agent.state !== 'needs-you') continue;
    const zone = BORROW_ORDER.find(candidate => freeSlot(candidate) >= 0);
    if (zone) {
      seat(agent, zone, freeSlot(zone));
      continue;
    }
    const calm = [...agents].reverse().find(other => other.state !== 'needs-you' && placements.has(other.id));
    const calmSeat = calm && placements.get(calm.id);
    if (!calm || calmSeat?.kind !== 'seat') {
      stacked.add(agent.id);
      continue;
    }
    placements.delete(calm.id);
    stacked.add(calm.id);
    taken[calmSeat.zone].delete(calmSeat.slot);
    seat(agent, calmSeat.zone, calmSeat.slot);
  }

  const depth: Record<TavernZone, number> = { workbench: 0, bar: 0, hearth: 0, benches: 0 };
  for (const agent of agents) {
    if (!stacked.has(agent.id)) continue;
    const zone = zoneFor(agent.state);
    placements.set(agent.id, { kind: 'overflow', zone, index: depth[zone]++, point: OVERFLOW_POINTS[zone] });
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

/**
 * Widest a label at `point` on `lane` can be without meeting any of `others` or running past the
 * scene's side walls (the scene clips it), all centred under their points.
 */
function labelCap(point: SlotPoint, lane: 0 | 1, others: Iterable<LaidOut>): number {
  const top = point.y + lane * LABEL_SPAN;
  let cap = Math.min(NAME_LABEL_MAX_WIDTH, 2 * (Math.min(point.x, 100 - point.x) - LABEL_GUTTER));
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

export type WaitingSeat = { id: string; zone: TavernZone; point: SlotPoint };

/**
 * Agents waiting in one zone share a single "needs you" bubble. Seats are closer together than
 * the bubble is wide at most stage sizes (bar seats 6% of the scene apart, the bubble 5% to 28%,
 * since its text has a pixel floor), so one bubble each would pile up. Returns the agent each
 * zone's bubble sits over, the one nearest the group's middle (leftmost on a tie), and how many
 * agents it speaks for.
 */
export function needsYouBubbles(waiting: Iterable<WaitingSeat>): Map<string, number> {
  const byZone = new Map<TavernZone, WaitingSeat[]>();
  for (const seat of waiting) byZone.set(seat.zone, [...(byZone.get(seat.zone) ?? []), seat]);
  const carriers = new Map<string, number>();
  for (const group of byZone.values()) {
    const total = group.reduce((sum, seat) => sum + seat.point.x, 0);
    // Scaled by the group size so the middle stays exact for whole-number seats.
    const offset = (seat: WaitingSeat) => Math.abs(group.length * seat.point.x - total);
    const carrier = group.reduce((best, seat) =>
      offset(seat) < offset(best) || (offset(seat) === offset(best) && seat.point.x < best.point.x) ? seat : best
    );
    carriers.set(carrier.id, group.length);
  }
  return carriers;
}
