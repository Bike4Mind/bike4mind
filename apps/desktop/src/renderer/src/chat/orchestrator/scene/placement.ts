import type { AgentState } from '@shared/agentState';
import type { SceneDefinition, ScenePoint } from './sceneDefinition';

/** The part of a scene placement reads: its zones, which zone each agent sits in, and where needs-you borrows. */
export interface PlacementMap {
  zones: Readonly<Record<string, { slots: readonly ScenePoint[]; overflow: ScenePoint }>>;
  zoneOf(agent: PlacedAgent): string;
  borrowOrder: readonly string[];
}

export interface PlacedAgent {
  id: string;
  state: AgentState;
  /** Set while the agent's workspace is still being set up (AgentView.preparing). */
  preparing?: unknown;
}

/**
 * A `seat` is one of the zone's slots; `borrowed` marks a needs-you agent seated outside its full zone.
 * An `overflow` agent has no seat and waits, `index`-th, in its zone's stack.
 */
export type Placement =
  | { kind: 'seat'; zone: string; slot: number; point: ScenePoint; borrowed: boolean }
  | { kind: 'overflow'; zone: string; index: number; point: ScenePoint };

export function placementMap(scene: SceneDefinition): PlacementMap {
  const { zone: zoneTable, preparing } = scene.states;
  return {
    zones: scene.map.zones,
    zoneOf: agent =>
      preparing !== undefined && agent.state === 'working' && agent.preparing !== undefined
        ? preparing
        : zoneTable[agent.state],
    borrowOrder: scene.map.borrowOrder,
  };
}

/**
 * Seats agents so nobody shuffles needlessly: an agent whose zone is unchanged keeps its previous slot,
 * the rest take the lowest free slot in their zone, and whoever finds the zone full joins that zone's
 * overflow stack in roster order. A needs-you agent is never stacked while any seat could hold it: it
 * borrows a free seat elsewhere (`borrowOrder`), and failing that takes the seat of the last calm agent
 * in the roster, who goes to its own zone's stack instead.
 */
export function placeAgents(
  agents: readonly PlacedAgent[],
  previous: ReadonlyMap<string, Placement>,
  map: PlacementMap
): Map<string, Placement> {
  const taken = new Map<string, Set<number>>();
  // Lowest slot that might be free, per zone; slots are only taken while seating, so it only moves up.
  const cursor = new Map<string, number>();
  for (const zone of Object.keys(map.zones)) {
    taken.set(zone, new Set());
    cursor.set(zone, 0);
  }
  const takenIn = (zone: string) => {
    const set = taken.get(zone);
    if (!set) throw new Error(`placeAgents: unknown zone "${zone}"`);
    return set;
  };
  const placements = new Map<string, Placement>();
  const seat = (agent: PlacedAgent, zone: string, slot: number) => {
    takenIn(zone).add(slot);
    placements.set(agent.id, {
      kind: 'seat',
      zone,
      slot,
      point: map.zones[zone].slots[slot],
      borrowed: zone !== map.zoneOf(agent),
    });
  };
  const freeSlot = (zone: string) => {
    const used = takenIn(zone);
    const slots = map.zones[zone].slots.length;
    let slot = cursor.get(zone) ?? 0;
    while (slot < slots && used.has(slot)) slot++;
    cursor.set(zone, slot);
    return slot < slots ? slot : -1;
  };
  const release = (zone: string, slot: number) => {
    takenIn(zone).delete(slot);
    cursor.set(zone, Math.min(cursor.get(zone) ?? 0, slot));
  };

  const seatAtHome = (agent: PlacedAgent) => {
    const zone = map.zoneOf(agent);
    const free = freeSlot(zone);
    if (free >= 0) seat(agent, zone, free);
    return free >= 0;
  };

  for (const agent of agents) {
    const before = previous.get(agent.id);
    if (before?.kind !== 'seat' || !taken.has(before.zone) || takenIn(before.zone).has(before.slot)) continue;
    if (before.slot >= map.zones[before.zone].slots.length) continue;
    if (before.zone === map.zoneOf(agent)) seat(agent, before.zone, before.slot);
  }

  // A freed seat at home beats a borrowed one; a borrowed seat is kept over newcomers to its zone.
  for (const agent of agents) {
    if (agent.state !== 'needs-you' || placements.has(agent.id) || seatAtHome(agent)) continue;
    const before = previous.get(agent.id);
    if (
      before?.kind === 'seat' &&
      before.borrowed &&
      taken.has(before.zone) &&
      before.slot < map.zones[before.zone].slots.length &&
      !takenIn(before.zone).has(before.slot)
    ) {
      seat(agent, before.zone, before.slot);
    }
  }

  const unseated: PlacedAgent[] = [];
  for (const agent of agents) {
    if (placements.has(agent.id)) continue;
    if (agent.state === 'needs-you' || !seatAtHome(agent)) unseated.push(agent);
  }

  const stacked = new Set(unseated.filter(agent => agent.state !== 'needs-you').map(agent => agent.id));
  // Calm agents only ever lose seats in this loop, so the search for the last seated one only walks back.
  let calmIndex = agents.length - 1;
  for (const agent of unseated) {
    if (agent.state !== 'needs-you') continue;
    const zone = map.borrowOrder.find(candidate => freeSlot(candidate) >= 0);
    if (zone) {
      seat(agent, zone, freeSlot(zone));
      continue;
    }
    while (calmIndex >= 0 && (agents[calmIndex].state === 'needs-you' || !placements.has(agents[calmIndex].id))) {
      calmIndex--;
    }
    const calm = calmIndex >= 0 ? agents[calmIndex] : undefined;
    const calmSeat = calm && placements.get(calm.id);
    if (!calm || calmSeat?.kind !== 'seat') {
      stacked.add(agent.id);
      continue;
    }
    placements.delete(calm.id);
    stacked.add(calm.id);
    release(calmSeat.zone, calmSeat.slot);
    seat(agent, calmSeat.zone, calmSeat.slot);
  }

  const depth = new Map<string, number>();
  for (const agent of agents) {
    if (!stacked.has(agent.id)) continue;
    const zone = map.zoneOf(agent);
    const index = depth.get(zone) ?? 0;
    depth.set(zone, index + 1);
    placements.set(agent.id, { kind: 'overflow', zone, index, point: map.zones[zone].overflow });
  }
  return placements;
}
