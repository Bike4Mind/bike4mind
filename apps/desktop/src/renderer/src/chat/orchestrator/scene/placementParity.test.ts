// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { AgentState } from '@shared/agentState';
import { placeAgents, placementMap, type PlacedAgent, type Placement, type PlacementMap } from './placement';
import { SCENE_VIEW_IDS, registeredScene } from './registeredScenes';

const STATES: AgentState[] = ['working', 'waiting', 'needs-you', 'done', 'failed', 'paused', 'stopped', 'idle'];
const HISTORIES = 40;
const STEPS = 12;

/** A seeded LCG, so a failing history replays exactly. */
function seeded(seed: number) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2 ** 31;
    return value / 2 ** 31;
  };
}

/** Roster after roster: agents leave, change state, are set up, and arrive, as a run does. */
function rosterHistory(seed: number, crowd: number): PlacedAgent[][] {
  const random = seeded(seed);
  const pick = () => STATES[Math.floor(random() * STATES.length)];
  let roster: PlacedAgent[] = Array.from({ length: Math.floor(random() * crowd) }, (_, index) => ({
    id: `h${seed}-${index}`,
    state: pick(),
  }));
  const history: PlacedAgent[][] = [];
  for (let step = 0; step < STEPS; step++) {
    roster = roster
      .filter(() => random() > 0.1)
      .map(agent => {
        if (random() >= 0.3) return agent;
        const state = pick();
        return state === 'working' && random() < 0.3
          ? { id: agent.id, state, preparing: true }
          : { id: agent.id, state };
      });
    const arrivals = Math.floor(random() * 4);
    for (let index = 0; index < arrivals; index++) roster.push({ id: `h${seed}-n${step}-${index}`, state: pick() });
    history.push(roster);
  }
  return history;
}

function replay(history: readonly PlacedAgent[][], map: PlacementMap): Map<string, Placement>[] {
  let previous: ReadonlyMap<string, Placement> = new Map();
  return history.map(roster => {
    const placed = placeAgents(roster, previous, map);
    previous = placed;
    return placed;
  });
}

/** Every rule a placement must keep, whatever the map: one seat per agent, stacks in order, needs-you on screen. */
function checkStep(
  roster: readonly PlacedAgent[],
  placed: ReadonlyMap<string, Placement>,
  previous: ReadonlyMap<string, Placement>,
  map: PlacementMap
) {
  expect([...placed.keys()].sort()).toEqual(roster.map(agent => agent.id).sort());
  const seats = new Map<string, string>();
  const depth = new Map<string, number>();
  for (const agent of roster) {
    const placement = placed.get(agent.id);
    if (!placement) throw new Error(`${agent.id} was not placed`);
    if (placement.kind === 'seat') {
      const key = `${placement.zone}#${placement.slot}`;
      expect(seats.get(key), `${key} given twice`).toBeUndefined();
      seats.set(key, agent.id);
      expect(placement.point).toEqual(map.zones[placement.zone].slots[placement.slot]);
      expect(placement.borrowed).toBe(placement.zone !== map.zoneOf(agent));
      if (placement.borrowed) expect(agent.state).toBe('needs-you');
    } else {
      expect(placement.zone).toBe(map.zoneOf(agent));
      expect(placement.point).toEqual(map.zones[placement.zone].overflow);
      expect(placement.index, 'stacks fill in roster order').toBe(depth.get(placement.zone) ?? 0);
      depth.set(placement.zone, placement.index + 1);
    }
  }
  const calmSeated = roster.some(agent => agent.state !== 'needs-you' && placed.get(agent.id)?.kind === 'seat');
  for (const agent of roster) {
    if (agent.state === 'needs-you' && placed.get(agent.id)?.kind === 'overflow') expect(calmSeated).toBe(false);
  }

  // Sticky: an agent still at home keeps its seat, unless a needs-you agent took it.
  for (const agent of roster) {
    const before = previous.get(agent.id);
    if (before?.kind !== 'seat' || before.zone !== map.zoneOf(agent)) continue;
    const now = placed.get(agent.id);
    if (now?.kind === 'seat') {
      expect(now.slot, `${agent.id} moved seat`).toBe(before.slot);
      continue;
    }
    expect(agent.state, `${agent.id} lost its seat`).not.toBe('needs-you');
    const taker = roster.find(other => other.id === seats.get(`${before.zone}#${before.slot}`));
    expect(taker?.state, `${agent.id} lost its seat to no one waiting`).toBe('needs-you');
  }
}

// Replaces the check against the old Tavern allocator: every registered map, not only the Tavern's.
describe.each(SCENE_VIEW_IDS)('placement on the %s map', view => {
  const scene = registeredScene(view);
  if (!scene) {
    it('is a framework scene', () => expect.fail(`"${view}" is not registered through sceneView`));
    return;
  }
  const map = placementMap(scene);
  const seats = Object.values(scene.map.zones).reduce((sum, zone) => sum + zone.slots.length, 0);

  it('places random roster histories deterministically and stickily, keeping every rule', () => {
    for (let history = 0; history < HISTORIES; history++) {
      // Some histories stay roomy, some overfill the map so stacks and borrowing kick in.
      const rosters = rosterHistory(history + 1, history % 2 === 0 ? seats / 2 : seats * 2);
      const first = replay(rosters, map);
      expect(replay(rosters, map), `history ${history} replays the same`).toEqual(first);
      first.forEach((placed, step) => checkStep(rosters[step], placed, step === 0 ? new Map() : first[step - 1], map));
    }
  });
});
