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
  OVERFLOW_POINTS,
  TAVERN_SLOTS,
  assignCharacters,
  type CastSubject,
  hiddenByCounter,
  nameLabelLayout,
  needsYouBubbles,
  placeAgents,
  poseFor,
  zoneFor,
  type NameLabel,
  type Placement,
  type SlotPoint,
} from './scene';
import { CHARACTER_COUNT, characterSprite } from './tavernArt';
import { TAVERN_LAYOUT, tavernLayoutSchema } from './tavernLayout';
import layoutJson from '../../../assets/orchestrator/tavern/layout.json';

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

describe('tavern layout data', () => {
  const inScene = (point: SlotPoint) => point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100;

  it('gives every zone at least one slot and an overflow point, all inside the scene', () => {
    for (const zone of ['workbench', 'bar', 'hearth', 'benches'] as const) {
      expect(TAVERN_LAYOUT.slots[zone].length).toBeGreaterThan(0);
      expect(TAVERN_LAYOUT.slots[zone].every(inScene)).toBe(true);
      expect(inScene(TAVERN_LAYOUT.overflow[zone])).toBe(true);
    }
    for (const point of [TAVERN_LAYOUT.door, TAVERN_LAYOUT.innkeeper, TAVERN_LAYOUT.window, TAVERN_LAYOUT.hearthGlow]) {
      expect(inScene(point)).toBe(true);
    }
    expect(TAVERN_LAYOUT.lights.every(inScene)).toBe(true);
  });

  it('rejects a layout with a slot off the scene or a zone with no slots', () => {
    const offScene = structuredClone(layoutJson);
    offScene.slots.bar[0].x = 101;
    expect(tavernLayoutSchema.safeParse(offScene).success).toBe(false);
    const empty = structuredClone(layoutJson);
    empty.slots.hearth = [];
    expect(tavernLayoutSchema.safeParse(empty).success).toBe(false);
    expect(tavernLayoutSchema.safeParse(layoutJson).success).toBe(true);
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
  const slotOf = (placement: Placement | undefined) => (placement?.kind === 'seat' ? placement.slot : undefined);

  it('stacks working agents past the 6 workbenches in place, in roster order', () => {
    const agents = Array.from({ length: 12 }, (_, index) => agentFixture(`w${index}`, 'working'));
    const placements = placeAgents(agents, noHistory);
    const atBench = [...placements.values()].filter(placement => placement.kind === 'seat');
    const stacked = agents.slice(6).map(agent => placements.get(agent.id));
    expect(atBench).toHaveLength(6);
    expect(stacked.every(placement => placement?.kind === 'overflow' && placement.zone === 'workbench')).toBe(true);
    expect(stacked.map(placement => (placement?.kind === 'overflow' ? placement.index : -1))).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(stacked.every(placement => placement?.point === OVERFLOW_POINTS.workbench)).toBe(true);
  });

  it('keeps an unchanged agent in its slot when another agent leaves the zone', () => {
    const first = placeAgents(
      [agentFixture('a', 'working'), agentFixture('b', 'working'), agentFixture('c', 'working')],
      noHistory
    );
    const cSlot = slotOf(first.get('c'));
    const second = placeAgents(
      [agentFixture('a', 'done'), agentFixture('b', 'working'), agentFixture('c', 'working')],
      first
    );
    expect(second.get('c')).toEqual(first.get('c'));
    expect(second.get('b')).toEqual(first.get('b'));
    expect(slotOf(second.get('c'))).toBe(cSlot);
    expect(second.get('a')?.zone).toBe('hearth');
  });

  it('gives a newcomer the lowest free slot without disturbing kept agents', () => {
    const first = placeAgents([agentFixture('a', 'working'), agentFixture('b', 'working')], noHistory);
    const second = placeAgents([agentFixture('new', 'working'), agentFixture('b', 'working')], first);
    expect(slotOf(second.get('b'))).toBe(slotOf(first.get('b')));
    expect(slotOf(second.get('new'))).toBe(slotOf(first.get('a')));
  });

  it('lets a stacked agent take a seat once one frees up', () => {
    const agents = Array.from({ length: 7 }, (_, index) => agentFixture(`w${index}`, 'working'));
    const first = placeAgents(agents, noHistory);
    expect(first.get('w6')).toMatchObject({ kind: 'overflow', zone: 'workbench' });
    const second = placeAgents([agentFixture('w0', 'done'), ...agents.slice(1)], first);
    const freed = first.get('w0');
    expect(second.get('w6')).toMatchObject({ kind: 'seat', zone: 'workbench', slot: slotOf(freed) });
  });

  it('seats a needs-you agent on a free bench once the bar is full, and keeps it there', () => {
    const agents = Array.from({ length: 5 }, (_, index) => agentFixture(`n${index}`, 'needs-you'));
    const first = placeAgents(agents, noHistory);
    expect(first.get('n4')).toMatchObject({ kind: 'seat', zone: 'benches', slot: 0, borrowed: true });
    const second = placeAgents([...agents, agentFixture('f', 'failed')], first);
    expect(second.get('n4')).toEqual(first.get('n4'));
    expect(second.get('f')).toMatchObject({ kind: 'seat', zone: 'benches', slot: 1, borrowed: false });
  });

  it('moves a borrowed needs-you agent back when the bar frees while borrowed', () => {
    const needing = Array.from({ length: 5 }, (_, index) => agentFixture(`n${index}`, 'needs-you'));
    const first = placeAgents(needing, noHistory);
    expect(first.get('n4')).toMatchObject({ kind: 'seat', zone: 'benches', borrowed: true });
    const failed = Array.from({ length: 6 }, (_, index) => agentFixture(`f${index}`, 'failed'));
    const second = placeAgents([agentFixture('n0', 'working'), ...needing.slice(1), ...failed], first);
    expect(second.get('n4')).toMatchObject({
      kind: 'seat',
      zone: 'bar',
      slot: slotOf(first.get('n0')),
      borrowed: false,
    });
    for (const agent of failed) expect(second.get(agent.id)).toMatchObject({ kind: 'seat', zone: 'benches' });
  });

  it("gives a needs-you agent the last calm agent's seat once every other seat is taken", () => {
    const calm = [
      ...Array.from({ length: 6 }, (_, index) => agentFixture(`w${index}`, 'working')),
      ...Array.from({ length: 4 }, (_, index) => agentFixture(`d${index}`, 'done')),
      ...Array.from({ length: 6 }, (_, index) => agentFixture(`f${index}`, 'failed')),
    ];
    const needing = Array.from({ length: 6 }, (_, index) => agentFixture(`n${index}`, 'needs-you'));
    const placements = placeAgents([...calm, ...needing], noHistory);
    for (const agent of needing) expect(placements.get(agent.id)?.kind).toBe('seat');
    expect(placements.get('f5')).toMatchObject({ kind: 'overflow', zone: 'benches', index: 1 });
    expect(placements.get('f4')).toMatchObject({ kind: 'overflow', zone: 'benches', index: 0 });
    expect(placements.get('f3')?.kind).toBe('seat');
  });

  it('stacks a needs-you agent only once every seat in the room holds one', () => {
    const agents = Array.from({ length: 21 }, (_, index) => agentFixture(`n${index}`, 'needs-you'));
    const placements = placeAgents(agents, noHistory);
    expect([...placements.values()].filter(placement => placement.kind === 'seat')).toHaveLength(20);
    expect(placements.get('n20')).toMatchObject({ kind: 'overflow', zone: 'bar', index: 0 });
  });

  it('places everyone in a busy room of 16 with 7 done, the extra done agents by the hearth', () => {
    const agents = [
      ...Array.from({ length: 7 }, (_, index) => agentFixture(`d${index}`, 'done')),
      ...Array.from({ length: 6 }, (_, index) => agentFixture(`w${index}`, 'working')),
      agentFixture('n0', 'needs-you'),
      agentFixture('f0', 'failed'),
      agentFixture('i0', 'idle'),
    ];
    const placements = placeAgents(agents, noHistory);
    expect(placements.size).toBe(agents.length);
    const hearthStack = [...placements.values()].filter(
      placement => placement.kind === 'overflow' && placement.zone === 'hearth'
    );
    expect(hearthStack).toHaveLength(3);
    expect([...placements.values()].filter(placement => placement.kind === 'overflow')).toHaveLength(3);
  });

  it('never puts two agents in the same zone and slot', () => {
    const states: AgentState[] = ['working', 'needs-you', 'done', 'failed', 'stopped', 'idle'];
    const agents = Array.from({ length: 30 }, (_, index) => agentFixture(`n${index}`, states[index % states.length]));
    let previous = new Map<string, Placement>();
    for (let round = 0; round < 3; round++) {
      const shuffled = agents.map((agent, index) => ({ ...agent, state: states[(index + round) % states.length] }));
      const placements = placeAgents(shuffled, previous);
      const keys = [...placements.values()].map(placement =>
        placement.kind === 'seat'
          ? `${placement.zone}:${placement.slot}`
          : `${placement.zone}:overflow:${placement.index}`
      );
      expect(new Set(keys).size).toBe(keys.length);
      expect(placements.size).toBe(agents.length);
      for (const [id, placement] of placements) {
        if (placement.kind === 'seat') expect(placement.point).toBe(TAVERN_SLOTS[placement.zone][placement.slot]);
        else expect(shuffled.find(agent => agent.id === id)?.state).not.toBe('needs-you');
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

  it('keeps every label inside the scene, so a seat by the wall never has its name cut off', () => {
    const points = allSeats();
    const layout = nameLabelLayout(points);
    for (const [id, label] of layout) {
      const { x } = points.get(id)!;
      expect(x - label.maxWidth / 2).toBeGreaterThanOrEqual(0);
      expect(x + label.maxWidth / 2).toBeLessThanOrEqual(100);
    }
    expect(nameLabelLayout(new Map([['wall', { x: 95, y: 50 }]])).get('wall')?.maxWidth).toBeCloseTo(9);
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

describe('needsYouBubbles', () => {
  const bar = TAVERN_SLOTS.bar;
  const atBar = (id: string, slot: number) => ({ id, zone: 'bar' as const, point: bar[slot] });

  it('gives a lone waiting agent its own bubble', () => {
    expect(needsYouBubbles([atBar('a', 2)])).toEqual(new Map([['a', 1]]));
  });

  it('puts one bubble over the middle of a zone, speaking for everyone waiting there', () => {
    expect(needsYouBubbles([atBar('a', 0), atBar('b', 1), atBar('c', 2)])).toEqual(new Map([['b', 3]]));
  });

  it('takes the leftmost of the two middle agents of an even group', () => {
    expect(needsYouBubbles([atBar('b', 1), atBar('a', 0)])).toEqual(new Map([['a', 2]]));
    expect(needsYouBubbles([atBar('a', 0), atBar('b', 1), atBar('c', 2), atBar('d', 3)])).toEqual(new Map([['b', 4]]));
  });

  it('keeps one bubble per zone', () => {
    const bench = { id: 'e', zone: 'benches' as const, point: TAVERN_SLOTS.benches[0] };
    expect(needsYouBubbles([atBar('a', 0), atBar('b', 1), bench])).toEqual(
      new Map([
        ['a', 2],
        ['e', 1],
      ])
    );
  });

  it('draws no bubble when nobody is waiting', () => {
    expect(needsYouBubbles([])).toEqual(new Map());
  });
});
