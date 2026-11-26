import { describe, expect, it } from 'vitest';
import type { AgentState, AgentView } from '../roster';
import { placeAgents, placementMap, type Placement } from '../scene/placement';
import { sceneDefinitionSchema, type ScenePoint } from '../scene/sceneDefinition';
import { nameLabelLayout } from '../scene/stageGeometry';
import { OFFICE_SCENE } from './officeScene';

const { map, states, cast } = OFFICE_SCENE;
const MAP = placementMap(OFFICE_SCENE);
const slots = Object.entries(map.zones).flatMap(([zone, { slots: points }]) =>
  points.map((point, slot) => ({ zone, slot, point }))
);
// A sprite canvas is square, so its width as a percent of the scene width is its height scaled by the aspect.
const spriteWidth = (cast.spriteHeight * map.aspect.height) / map.aspect.width;

// testUtils needs a DOM; placement only reads id, state and preparing.
const agent = (id: string, state: AgentState, extra: Partial<AgentView> = {}): AgentView => ({
  id,
  title: `Agent ${id}`,
  parentId: 'root',
  depth: 1,
  seedPrompt: '',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  model: 'm',
  state,
  ...extra,
});
const place = (agents: AgentView[], previous: ReadonlyMap<string, Placement> = new Map()) =>
  placeAgents(agents, previous, MAP);

describe('OFFICE_SCENE', () => {
  it('is a valid scene definition', () => {
    expect(sceneDefinitionSchema.safeParse(OFFICE_SCENE).success).toBe(true);
  });

  it('sends each state to its room, and a working agent still setting up to reception', () => {
    expect(states.zone).toEqual({
      working: 'desks',
      waiting: 'desks',
      'needs-you': 'manager-door',
      done: 'break',
      failed: 'conference',
      paused: 'conference',
      stopped: 'conference',
      idle: 'conference',
    });
    expect(MAP.zoneOf(agent('a', 'working', { preparing: 'worktree' }))).toBe('reception');
    expect(MAP.zoneOf(agent('a', 'working'))).toBe('desks');
    // Only a working agent is ever preparing; any other state keeps its own room.
    expect(MAP.zoneOf(agent('a', 'done', { preparing: 'worktree' }))).toBe('break');
  });

  it('keeps every sprite and its plate whole inside the scene', () => {
    for (const { point } of [...slots, { point: map.host }, { point: map.door }]) {
      expect(point.y - cast.spriteHeight).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(97);
      expect(point.x - spriteWidth / 2).toBeGreaterThanOrEqual(0);
      expect(point.x + spriteWidth / 2).toBeLessThanOrEqual(100);
    }
  });

  it('keeps sprites from standing on each other', () => {
    const tooClose = (a: ScenePoint, b: ScenePoint) =>
      Math.abs(a.x - b.x) < spriteWidth * 0.75 && Math.abs(a.y - b.y) < cast.spriteHeight * 0.6;
    const points = [...slots.map(({ point }) => point), map.host];
    points.forEach((a, i) =>
      points.slice(i + 1).forEach(b => expect(tooClose(a, b), JSON.stringify([a, b])).toBe(false))
    );
  });

  it('hangs the bulletin board clear of every sprite', () => {
    const { board } = map;
    for (const { point } of [...slots, { point: map.host }]) {
      const overlapsX = point.x + spriteWidth / 2 > board.left && point.x - spriteWidth / 2 < board.left + board.width;
      const overlapsY = point.y > board.top && point.y - cast.spriteHeight < board.top + board.height;
      expect(overlapsX && overlapsY, JSON.stringify(point)).toBe(false);
    }
  });

  it('seats a full office once each, sending the rest to the stacks', () => {
    const roster = [
      ...Array.from({ length: 14 }, (_, i) => agent(`w${i}`, 'working')),
      ...Array.from({ length: 10 }, (_, i) => agent(`d${i}`, 'done')),
      ...Array.from({ length: 3 }, (_, i) => agent(`n${i}`, 'needs-you')),
    ];
    const placed = place(roster);
    const seats = [...placed.values()].filter(placement => placement.kind === 'seat');
    expect(new Set(seats.map(seat => `${seat.zone}#${seat.slot}`)).size).toBe(seats.length);
    expect(seats.filter(seat => seat.zone === 'desks')).toHaveLength(map.zones.desks.slots.length);
    expect(seats.filter(seat => seat.zone === 'manager-door')).toHaveLength(3);
    expect([...placed.values()].filter(placement => placement.kind === 'overflow')).toHaveLength(
      14 - map.zones.desks.slots.length + 10 - map.zones.break.slots.length
    );
  });

  it('walks an agent from reception to a desk once its workspace is ready', () => {
    const first = place([agent('a', 'working', { preparing: 'worktree' })]);
    expect(first.get('a')).toMatchObject({ kind: 'seat', zone: 'reception' });
    expect(place([agent('a', 'working')], first).get('a')).toMatchObject({ kind: 'seat', zone: 'desks', slot: 0 });
  });

  it('shows the name plate of every agent in a full office', () => {
    const labels = nameLabelLayout(new Map(slots.map(({ zone, slot, point }) => [`${zone}#${slot}`, point])));
    expect([...labels.values()].every(label => label.shown)).toBe(true);
  });
});
