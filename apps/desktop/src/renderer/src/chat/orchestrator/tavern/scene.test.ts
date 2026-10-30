import { describe, expect, it } from 'vitest';
import type { AgentState, AgentView } from '../roster';
import { DOOR_POINT, TAVERN_SLOTS, characterFor, placeAgents, poseFor, zoneFor, type Placement } from './scene';

// testUtils needs a DOM; placement only reads id and state.
const agentFixture = (id: string, state: AgentState): AgentView => ({
  id,
  title: `Agent ${id}`,
  parentId: 'root',
  depth: 1,
  seedPrompt: '',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  model: 'm',
  state,
});

describe('zoneFor / poseFor', () => {
  it.each([
    ['working', 'workbench', 'work'],
    ['needs-you', 'bar', 'call'],
    ['done', 'hearth', 'rest'],
    ['failed', 'benches', 'ko'],
    ['stopped', 'benches', 'idle'],
    ['idle', 'benches', 'idle'],
  ] as const)('%s -> %s, %s', (state: AgentState, zone, pose) => {
    expect(zoneFor(state)).toBe(zone);
    expect(poseFor(state)).toBe(pose);
  });
});

describe('TAVERN_SLOTS', () => {
  it('has 6 workbench, 4 bar, 4 hearth and 6 bench slots inside the scene', () => {
    expect(TAVERN_SLOTS.workbench).toHaveLength(6);
    expect(TAVERN_SLOTS.bar).toHaveLength(4);
    expect(TAVERN_SLOTS.hearth).toHaveLength(4);
    expect(TAVERN_SLOTS.benches).toHaveLength(6);
    for (const point of [...Object.values(TAVERN_SLOTS).flat(), DOOR_POINT]) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(100);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(100);
    }
  });
});

describe('characterFor', () => {
  it('is stable for the same id and within 1..4', () => {
    for (const id of ['a', 'session-123', 'x'.repeat(40), '']) {
      const character = characterFor(id);
      expect(characterFor(id)).toBe(character);
      expect([1, 2, 3, 4]).toContain(character);
    }
  });

  it('spreads ids over more than one character', () => {
    const characters = new Set(Array.from({ length: 20 }, (_, index) => characterFor(`agent-${index}`)));
    expect(characters.size).toBeGreaterThan(1);
  });
});

describe('placeAgents', () => {
  const noHistory = new Map<string, Placement>();

  it('queues working agents past the 6 workbenches at the door with distinct indices', () => {
    const agents = Array.from({ length: 12 }, (_, index) => agentFixture(`w${index}`, 'working'));
    const placements = placeAgents(agents, noHistory);
    const atBench = [...placements.values()].filter(placement => placement.zone === 'workbench');
    const atDoor = agents.slice(6).map(agent => placements.get(agent.id));
    expect(atBench).toHaveLength(6);
    expect(atDoor.every(placement => placement?.zone === 'door')).toBe(true);
    expect(atDoor.map(placement => placement?.slot)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(atDoor.every(placement => placement?.point === DOOR_POINT)).toBe(true);
  });

  it('keeps an unchanged agent in its slot when another agent leaves the zone', () => {
    const first = placeAgents(
      [agentFixture('a', 'working'), agentFixture('b', 'working'), agentFixture('c', 'working')],
      noHistory
    );
    const cSlot = first.get('c')?.slot;
    const second = placeAgents(
      [agentFixture('a', 'done'), agentFixture('b', 'working'), agentFixture('c', 'working')],
      first
    );
    expect(second.get('c')).toEqual(first.get('c'));
    expect(second.get('b')).toEqual(first.get('b'));
    expect(second.get('c')?.slot).toBe(cSlot);
    expect(second.get('a')?.zone).toBe('hearth');
  });

  it('gives a newcomer the lowest free slot without disturbing kept agents', () => {
    const first = placeAgents([agentFixture('a', 'working'), agentFixture('b', 'working')], noHistory);
    const second = placeAgents([agentFixture('new', 'working'), agentFixture('b', 'working')], first);
    expect(second.get('b')?.slot).toBe(first.get('b')?.slot);
    expect(second.get('new')?.slot).toBe(first.get('a')?.slot);
  });

  it('never puts two agents in the same zone and slot', () => {
    const states: AgentState[] = ['working', 'needs-you', 'done', 'failed', 'stopped', 'idle'];
    const agents = Array.from({ length: 30 }, (_, index) => agentFixture(`n${index}`, states[index % states.length]));
    let previous = new Map<string, Placement>();
    for (let round = 0; round < 3; round++) {
      const shuffled = agents.map((agent, index) => ({ ...agent, state: states[(index + round) % states.length] }));
      const placements = placeAgents(shuffled, previous);
      const keys = [...placements.values()].map(placement => `${placement.zone}:${placement.slot}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(placements.size).toBe(agents.length);
      for (const placement of placements.values()) {
        if (placement.zone !== 'door') expect(placement.point).toBe(TAVERN_SLOTS[placement.zone][placement.slot]);
      }
      previous = placements;
    }
  });
});
