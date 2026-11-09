import { describe, expect, it } from 'vitest';
import type { Epithet } from '@shared/agentPersona';
import type { AgentState, AgentView } from '../roster';
import {
  BAR_COUNTER,
  DOOR_POINT,
  INNKEEPER_POINT,
  LABEL_SPAN,
  NAME_LABEL_MAX_WIDTH,
  NAME_LABEL_MIN_WIDTH,
  TAVERN_SLOTS,
  assignCharacters,
  type CastSubject,
  hiddenByCounter,
  nameLabelLayout,
  placeAgents,
  poseFor,
  zoneFor,
  type NameLabel,
  type Placement,
  type SlotPoint,
} from './scene';
import { CHARACTER_COUNT, characterSprite } from './tavernArt';

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
  it('keeps fireside agents from standing on each other', () => {
    const hearth = TAVERN_SLOTS.hearth;
    for (const [i, a] of hearth.entries()) {
      for (const b of hearth.slice(i + 1)) {
        expect(Math.abs(a.x - b.x) >= 7 || Math.abs(a.y - b.y) >= 12).toBe(true);
      }
    }
  });

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

describe('assignCharacters', () => {
  const subject = (id: string, minute: number, epithet?: Epithet): CastSubject => ({
    id,
    createdAt: `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`,
    epithet,
  });
  const crafts: Record<number, Epithet> = { 1: 'Tinkerer', 2: 'Scribe', 3: 'Seeker', 4: 'Tinkerer' };
  const craftOf = (character: number) => crafts[character] ?? 'Wanderer';

  it('never repeats a character while unused sheets remain, even when every agent does the same work', () => {
    const scribes = ['a', 'b', 'c', 'd'].map((id, index) => subject(`session-${id}`, index, 'Scribe'));
    const characters = assignCharacters(scribes, 4, craftOf);
    expect(new Set(characters.values()).size).toBe(4);
  });

  it('is the same on every call and whatever order the roster arrives in', () => {
    const roster = Array.from({ length: 6 }, (_, index) => subject(`agent-${index}`, index, 'Scribe'));
    const first = assignCharacters(roster, 4, craftOf);
    expect(assignCharacters([...roster].reverse(), 4, craftOf)).toEqual(first);
    expect(assignCharacters(roster, 4, craftOf)).toEqual(first);
  });

  it('gives the oldest agent the character that looks the part of its work', () => {
    const characters = assignCharacters([subject('x', 0, 'Scribe'), subject('y', 1, 'Seeker')], 4, craftOf);
    expect(characters.get('x')).toBe(2);
    expect(characters.get('y')).toBe(3);
  });

  it('keeps existing agents in their characters when a newer agent joins', () => {
    const before = [subject('one', 0), subject('two', 1), subject('three', 2)];
    const first = assignCharacters(before, 4, craftOf);
    const after = assignCharacters([...before, subject('four', 3)], 4, craftOf);
    for (const agent of before) expect(after.get(agent.id)).toBe(first.get(agent.id));
  });

  it('repeats only once the cast is used up, then spreads the repeats', () => {
    const roster = Array.from({ length: 8 }, (_, index) => subject(`agent-${index}`, index));
    const characters = [...assignCharacters(roster, 4, craftOf).values()];
    expect(new Set(characters.slice(0, 4)).size).toBe(4);
    expect(new Set(characters.slice(4)).size).toBe(4);
  });

  it('covers the real cast with distinct sheets for a full roster', () => {
    const roster = Array.from({ length: CHARACTER_COUNT }, (_, index) => subject(`s-${index}`, index, 'Scribe'));
    const characters = assignCharacters(roster);
    expect(new Set(characters.values()).size).toBe(CHARACTER_COUNT);
    expect(new Set([...characters.values()].map(character => characterSprite(character, 'idle'))).size).toBe(
      CHARACTER_COUNT
    );
    for (const character of characters.values()) expect(characterSprite(character, 'idle')).toBeTruthy();
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

  it('keeps door queue indices across an unrelated roster change', () => {
    const agents = Array.from({ length: 8 }, (_, index) => agentFixture(`w${index}`, 'working'));
    const first = placeAgents(agents, noHistory);
    expect(first.get('w6')).toMatchObject({ zone: 'door', slot: 0 });
    expect(first.get('w7')).toMatchObject({ zone: 'door', slot: 1 });
    const reordered = [agents[7], ...agents.slice(0, 7), agentFixture('x', 'done')];
    const second = placeAgents(reordered, first);
    expect(second.get('w6')).toEqual(first.get('w6'));
    expect(second.get('w7')).toEqual(first.get('w7'));
  });

  it('lets a queued agent take a seat once one frees up', () => {
    const agents = Array.from({ length: 7 }, (_, index) => agentFixture(`w${index}`, 'working'));
    const first = placeAgents(agents, noHistory);
    const second = placeAgents([agentFixture('w0', 'done'), ...agents.slice(1)], first);
    expect(second.get('w6')).toMatchObject({ zone: 'workbench', slot: first.get('w0')?.slot });
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

describe('nameLabelLayout', () => {
  /**
   * Labels drawn at rest: centred under their point, `lane` label-spans lower, at most LABEL_SPAN tall.
   * Two clash when their bands meet vertically and their half-widths meet horizontally.
   */
  function overlapping(points: ReadonlyMap<string, SlotPoint>, layout: ReadonlyMap<string, NameLabel>): string[] {
    const drawn = [...points].filter(([id]) => layout.get(id)?.shown);
    const clashes: string[] = [];
    drawn.forEach(([idA, a], index) => {
      const labelA = layout.get(idA);
      for (const [idB, b] of drawn.slice(index + 1)) {
        const labelB = layout.get(idB);
        if (!labelA || !labelB) continue;
        const topA = a.y + labelA.lane * LABEL_SPAN;
        const topB = b.y + labelB.lane * LABEL_SPAN;
        if (Math.abs(topA - topB) >= LABEL_SPAN) continue;
        if ((labelA.maxWidth + labelB.maxWidth) / 2 > Math.abs(a.x - b.x)) clashes.push(`${idA}/${idB}`);
      }
    });
    return clashes;
  }

  const allSeats = () => {
    const points = new Map<string, SlotPoint>([['door', DOOR_POINT]]);
    for (const [zone, slots] of Object.entries(TAVERN_SLOTS)) {
      slots.forEach((point, slot) => points.set(`${zone}-${slot}`, point));
    }
    return points;
  };

  it('gives a lone agent the full width on the first line', () => {
    expect(nameLabelLayout(new Map([['a', { x: 50, y: 50 }]])).get('a')).toEqual({
      lane: 0,
      maxWidth: NAME_LABEL_MAX_WIDTH,
      shown: true,
    });
  });

  it('staggers alternate neighbours in a row, so each is capped by the next-but-one', () => {
    const points = new Map(TAVERN_SLOTS.bar.map((point, slot) => [`bar-${slot}`, point] as const));
    const layout = nameLabelLayout(points);
    expect([...layout.values()].map(label => label.lane)).toEqual([0, 1, 0, 1]);
    const gap = TAVERN_SLOTS.bar[1].x - TAVERN_SLOTS.bar[0].x;
    for (const label of layout.values()) expect(label.maxWidth).toBeGreaterThan(gap * 1.9);
    expect(overlapping(points, layout)).toEqual([]);
  });

  it('keeps every drawn label clear of every other with every seat and the door taken', () => {
    const points = allSeats();
    const layout = nameLabelLayout(points);
    expect(overlapping(points, layout)).toEqual([]);
    for (const label of layout.values()) expect(label.maxWidth).toBeGreaterThanOrEqual(7);
  });

  it('keeps the Innkeeper behind the bar, off every seat, with its label clear of every other', () => {
    const seats = allSeats();
    expect([...seats.values()]).not.toContainEqual(INNKEEPER_POINT);
    expect(INNKEEPER_POINT.y).toBeLessThan(Math.min(...TAVERN_SLOTS.bar.map(point => point.y)));
    const points = new Map([...seats, ['innkeeper', INNKEEPER_POINT]]);
    const layout = nameLabelLayout(points);
    expect(overlapping(points, layout)).toEqual([]);
    expect(layout.get('innkeeper')?.shown).toBe(true);
  });

  it('hides the Innkeeper below the counter top, waist up, so its feet never float over the front panel', () => {
    const hidden = hiddenByCounter(INNKEEPER_POINT, 15);
    // The counter edge lands at the waist: a third to a half of the box is cut away.
    expect(hidden).toBeGreaterThan(25);
    expect(hidden).toBeLessThan(50);
    expect(INNKEEPER_POINT.y - (15 * hidden) / 100).toBeCloseTo(BAR_COUNTER.top);
  });

  it('keeps every seat and the door whole, standing on visible floor', () => {
    for (const point of [...allSeats().values()]) expect(hiddenByCounter(point, 15)).toBe(0);
  });

  it('cuts nothing beside the counter and never more than the whole sprite', () => {
    expect(hiddenByCounter({ x: BAR_COUNTER.left - 1, y: 32 }, 15)).toBe(0);
    expect(hiddenByCounter({ x: BAR_COUNTER.right + 1, y: 32 }, 15)).toBe(0);
    expect(hiddenByCounter({ x: 60, y: BAR_COUNTER.top - 1 }, 15)).toBe(0);
    expect(hiddenByCounter({ x: 60, y: BAR_COUNTER.front - 0.1 }, 2)).toBe(100);
  });

  it('hides a label squeezed below the minimum rather than drawing an empty pill', () => {
    const points = new Map<string, SlotPoint>([
      ['left', { x: 50, y: 50 }],
      ['middle', { x: 51, y: 50 }],
      ['right', { x: 52, y: 50 }],
    ]);
    const layout = nameLabelLayout(points);
    expect(layout.get('left')?.shown).toBe(false);
    expect(layout.get('middle')?.shown).toBe(true);
    expect(layout.get('right')?.shown).toBe(false);
    expect(layout.get('left')?.maxWidth).toBeLessThan(NAME_LABEL_MIN_WIDTH);
    expect(overlapping(points, layout)).toEqual([]);
  });
});
