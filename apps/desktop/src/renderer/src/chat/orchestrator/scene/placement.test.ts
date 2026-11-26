import { describe, expect, it } from 'vitest';
import type { AgentState } from '@shared/agentState';
import type { AgentView } from '../roster';
import { placeAgents, placementMap, type Placement } from './placement';
import { TEST_SCENE } from './testScene';

const MAP = placementMap(TEST_SCENE);
const agent = (id: string, state: AgentState): AgentView => ({
  id,
  title: id,
  parentId: 'root',
  depth: 1,
  seedPrompt: '',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  model: 'm',
  state,
});
const place = (agents: AgentView[], previous: ReadonlyMap<string, Placement> = new Map()) =>
  placeAgents(agents, previous, MAP);
const seatOf = (placements: Map<string, Placement>, id: string) => {
  const placement = placements.get(id);
  return placement?.kind === 'seat'
    ? `${placement.zone}#${placement.slot}`
    : placement && `${placement.zone}+${placement.index}`;
};

describe('placeAgents', () => {
  it('seats each agent in its state zone at the lowest free slot', () => {
    const placed = place([agent('a', 'working'), agent('b', 'working'), agent('c', 'done')]);
    expect(seatOf(placed, 'a')).toBe('desk#0');
    expect(seatOf(placed, 'b')).toBe('desk#1');
    expect(seatOf(placed, 'c')).toBe('yard#0');
    expect(placed.get('a')).toMatchObject({ point: TEST_SCENE.map.zones.desk.slots[0], borrowed: false });
  });

  it('keeps an agent in its seat when one before it leaves (stickiness)', () => {
    const first = place([agent('a', 'working'), agent('b', 'working'), agent('c', 'working')]);
    const second = place([agent('b', 'working'), agent('c', 'working'), agent('d', 'working')], first);
    expect(seatOf(second, 'b')).toBe('desk#1');
    expect(seatOf(second, 'c')).toBe('desk#2');
    expect(seatOf(second, 'd')).toBe('desk#0');
  });

  it('keeps seats when the roster reorders, and moves an agent whose zone changed', () => {
    const first = place([agent('a', 'working'), agent('b', 'working')]);
    const second = place([agent('b', 'working'), agent('a', 'done')], first);
    expect(seatOf(second, 'b')).toBe('desk#1');
    expect(seatOf(second, 'a')).toBe('yard#0');
  });

  it('stacks a full zone in roster order at its overflow point', () => {
    const agents = ['a', 'b', 'c', 'd', 'e'].map(id => agent(id, 'working'));
    const placed = place(agents);
    expect(['a', 'b', 'c'].map(id => seatOf(placed, id))).toEqual(['desk#0', 'desk#1', 'desk#2']);
    expect(placed.get('d')).toEqual({ kind: 'overflow', zone: 'desk', index: 0, point: MAP.zones.desk.overflow });
    expect(seatOf(placed, 'e')).toBe('desk+1');
  });

  it('a stacked agent takes a seat as soon as one frees up', () => {
    const agents = ['a', 'b', 'c', 'd'].map(id => agent(id, 'working'));
    const first = place(agents);
    const second = place(agents.slice(1), first);
    expect(seatOf(second, 'd')).toBe('desk#0');
  });

  it('a needs-you agent borrows a seat in borrowOrder once its own zone is full', () => {
    const placed = place([agent('n1', 'needs-you'), agent('n2', 'needs-you'), agent('n3', 'needs-you')]);
    expect(seatOf(placed, 'n1')).toBe('porch#0');
    expect(seatOf(placed, 'n2')).toBe('porch#1');
    expect(seatOf(placed, 'n3')).toBe('yard#0');
    expect(placed.get('n3')).toMatchObject({ borrowed: true });
  });

  it('borrows from the next zone in order when the first is full', () => {
    const yard = ['y1', 'y2', 'y3', 'y4'].map(id => agent(id, 'done'));
    const placed = place([...yard, agent('n1', 'needs-you'), agent('n2', 'needs-you'), agent('n3', 'needs-you')]);
    expect(seatOf(placed, 'n3')).toBe('desk#0');
  });

  it('keeps a borrowed seat over a newcomer to that zone, and goes home when a home seat frees', () => {
    const first = place([agent('n1', 'needs-you'), agent('n2', 'needs-you'), agent('n3', 'needs-you')]);
    const withNewcomer = place(
      [agent('y0', 'done'), agent('n1', 'needs-you'), agent('n2', 'needs-you'), agent('n3', 'needs-you')],
      first
    );
    expect(seatOf(withNewcomer, 'n3')).toBe('yard#0');
    expect(seatOf(withNewcomer, 'y0')).toBe('yard#1');
    const freed = place([agent('n2', 'needs-you'), agent('n3', 'needs-you')], withNewcomer);
    expect(seatOf(freed, 'n3')).toBe('porch#0');
    expect(freed.get('n3')).toMatchObject({ borrowed: false });
  });

  it('when every seat is full, a needs-you agent takes the last calm agent seat and that agent is stacked', () => {
    const calm = [
      ...['w1', 'w2', 'w3'].map(id => agent(id, 'working')),
      ...['y1', 'y2', 'y3', 'y4'].map(id => agent(id, 'done')),
    ];
    const needy = ['n1', 'n2', 'n3'].map(id => agent(id, 'needs-you'));
    const placed = place([...calm, ...needy]);
    expect(seatOf(placed, 'n3')).toBe('yard#3');
    expect(seatOf(placed, 'y4')).toBe('yard+0');
    expect(placed.get('n3')).toMatchObject({ borrowed: true });
  });

  it('stacks a needs-you agent only when no calm agent holds a seat', () => {
    const needy = Array.from({ length: 11 }, (_, index) => agent(`n${index}`, 'needs-you'));
    const placed = place(needy);
    const stacked = [...placed.values()].filter(placement => placement.kind === 'overflow');
    expect(stacked).toEqual([
      { kind: 'overflow', zone: 'porch', index: 0, point: MAP.zones.porch.overflow },
      expect.anything(),
    ]);
    expect(seatOf(placed, 'n9')).toBe('porch+0');
  });

  it('drops a previous seat in a zone this scene does not have', () => {
    const previous = new Map<string, Placement>([
      ['a', { kind: 'seat', zone: 'gone', slot: 0, point: { x: 1, y: 1 }, borrowed: false }],
    ]);
    expect(seatOf(place([agent('a', 'working')], previous), 'a')).toBe('desk#0');
  });

  it('places hundreds of agents with no seat given twice, in linear-ish time', () => {
    const states: AgentState[] = ['working', 'needs-you', 'done', 'failed', 'waiting', 'idle'];
    const agents = Array.from({ length: 600 }, (_, index) => agent(`a${index}`, states[index % states.length]));
    const started = performance.now();
    let placed = place(agents);
    for (let round = 0; round < 20; round++) placed = place(agents, placed);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(placed.size).toBe(600);
    const seats = [...placed.values()].filter(placement => placement.kind === 'seat');
    const keys = seats.map(seat => `${seat.zone}#${seat.slot}`);
    expect(new Set(keys).size).toBe(keys.length);
    const total = Object.values(MAP.zones).reduce((sum, zone) => sum + zone.slots.length, 0);
    expect(seats).toHaveLength(total);
    // Every needs-you agent that could be seated is: all seats go to them first.
    const needySeated = seats.filter(seat => seat.kind === 'seat' && (seat.zone === 'porch' || seat.borrowed));
    expect(needySeated).toHaveLength(total);
  });

  it('sends a working agent still setting up to the preparing zone, and to its desk once ready', () => {
    const map = placementMap({ ...TEST_SCENE, states: { ...TEST_SCENE.states, preparing: 'porch' } });
    const setup = { ...agent('a', 'working'), preparing: 'worktree' as const };
    const first = placeAgents([setup], new Map(), map);
    expect(first.get('a')).toMatchObject({ kind: 'seat', zone: 'porch', borrowed: false });
    expect(placeAgents([agent('a', 'working')], first, map).get('a')).toMatchObject({ zone: 'desk', slot: 0 });
    // Without a preparing zone, setting up is just working.
    expect(place([setup]).get('a')).toMatchObject({ zone: 'desk' });
  });
});
