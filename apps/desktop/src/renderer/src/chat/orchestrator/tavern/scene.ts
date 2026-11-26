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
  // Still on the job: its background command will wake it.
  waiting: 'workbench',
  'needs-you': 'bar',
  done: 'hearth',
  failed: 'benches',
  paused: 'benches',
  stopped: 'benches',
  idle: 'benches',
};

const POSE: Record<AgentState, Pose> = {
  working: 'work',
  waiting: 'idle',
  'needs-you': 'call',
  done: 'rest',
  failed: 'ko',
  paused: 'idle',
  stopped: 'idle',
  idle: 'idle',
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
