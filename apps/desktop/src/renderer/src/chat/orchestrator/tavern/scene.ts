import type { AgentState, AgentView } from '../roster';
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
  hearth: [
    { x: 75, y: 50 },
    { x: 79, y: 58 },
    { x: 87, y: 60 },
    { x: 94, y: 66 },
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

export function characterFor(agentId: string): CharacterId {
  let hash = 0;
  for (let index = 0; index < agentId.length; index++) hash = (hash * 31 + agentId.charCodeAt(index)) >>> 0;
  return ((hash % 4) + 1) as CharacterId;
}

/** For the door, `slot` is the agent's index in the queue and `point` is always `DOOR_POINT`. */
export type Placement = { zone: TavernZone; point: SlotPoint; slot: number };

/**
 * Seats agents so nobody shuffles needlessly: an agent whose zone is unchanged keeps its previous slot,
 * the rest take the lowest free slot in their zone, and whoever finds the zone full queues at the door
 * in roster order.
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

  let queued = 0;
  for (const agent of agents) {
    if (placements.has(agent.id)) continue;
    const zone = zoneFor(agent.state);
    const free = TAVERN_SLOTS[zone].findIndex((_, slot) => !taken[zone].has(slot));
    if (free < 0) {
      placements.set(agent.id, { zone: 'door', point: DOOR_POINT, slot: queued++ });
      continue;
    }
    taken[zone].add(free);
    placements.set(agent.id, { zone, point: TAVERN_SLOTS[zone][free], slot: free });
  }
  return placements;
}
