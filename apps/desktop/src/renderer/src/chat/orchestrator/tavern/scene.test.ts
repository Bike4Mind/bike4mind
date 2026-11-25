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
  QUEST_BOARD,
  TAVERN_SLOTS,
  assignCharacters,
  type CastSubject,
  hiddenByCounter,
  nameLabelLayout,
  needsYouGroups,
  noteCapacity,
  pinNotes,
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
import { joinAnnouncements } from './announcements';
import type { ChatToolCall } from '@shared/chat';
import type { ChatQuestion } from '@shared/questions';
import { BUBBLE_OPTION_MAX, planForCall, planForQuestion } from './bubbleAnswer';
import type { AgentActivity } from '../activity';
import { innkeeperAct, innkeeperBubble } from './innkeeper';
import { EMPTY_LEDGER, QUEST_DONE_LINGER_MS, questNotes, questTitle, takeDown, trackQuests } from './quests';

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

  it('hangs the quest board inside the scene, above every seat and clear of the Innkeeper', () => {
    const { left, top, width, height } = QUEST_BOARD;
    expect(left + width).toBeLessThanOrEqual(100);
    expect(top + height).toBeLessThanOrEqual(100);
    // A sprite's box is 15% of the scene tall above its feet; none may reach up over the board.
    const spriteTop = (point: SlotPoint) => point.y - 15;
    const seats = [...Object.values(TAVERN_SLOTS).flat(), ...Object.values(OVERFLOW_POINTS), DOOR_POINT];
    expect(seats.every(point => spriteTop(point) >= top + height)).toBe(true);
    const innkeeperClear = INNKEEPER_POINT.x - 7.5 >= left + width || INNKEEPER_POINT.x + 7.5 <= left;
    expect(innkeeperClear).toBe(true);
  });

  it('rejects a quest board that holds fewer than two notes', () => {
    const tiny = structuredClone(layoutJson);
    tiny.questBoard.notes = 1;
    expect(tavernLayoutSchema.safeParse(tiny).success).toBe(false);
  });
});

describe('pinNotes', () => {
  it('pins everything when it fits', () => {
    expect(pinNotes([1, 2, 3], 3)).toEqual({ pinned: [1, 2, 3], hidden: [] });
  });

  it('gives the last place to the "+N" note once the board is over full', () => {
    expect(pinNotes([1, 2, 3, 4, 5], 3)).toEqual({ pinned: [1, 2], hidden: [3, 4, 5] });
  });
});

describe('noteCapacity', () => {
  // Board heights (px) as measured live in the desktop app, from a large scene down to a tiny one.
  it.each([
    [145, 3],
    [109, 2],
    [77, 2],
    [70, 2],
    [55, 2],
    [39, 1],
    [28, 1],
  ])('fits three quests on a %ipx board as %i places', (height, places) => {
    expect(noteCapacity(height, 3)).toBe(places);
  });

  it.each([
    [145, 3],
    [109, 3],
    [77, 2],
    [39, 1],
  ])('puts the last place of a %ipx board to the "+N" note for six quests (%i places)', (height, places) => {
    expect(noteCapacity(height, 6)).toBe(places);
    const { pinned, hidden } = pinNotes([1, 2, 3, 4, 5, 6], noteCapacity(height, 6));
    expect(pinned).toHaveLength(places - 1);
    expect(pinned.length + hidden.length).toBe(6);
  });

  it('never reports a capacity of every quest unless the full stack fits, so a clipped last note gets a "+N"', () => {
    const { pinned, hidden } = pinNotes([1, 2, 3], noteCapacity(109, 3));
    expect(pinned).toHaveLength(1);
    expect(hidden).toHaveLength(2);
  });

  it('gives no place at all once not even the "+N" note fits, so the board is not drawn', () => {
    expect(noteCapacity(16, 3)).toBe(0);
    expect(noteCapacity(7, 6)).toBe(0);
    expect(noteCapacity(0, 6)).toBe(0);
  });

  it('never exceeds the layout count and never shrinks as the board grows', () => {
    let last = 0;
    for (let height = 0; height <= 400; height += 1) {
      const places = noteCapacity(height, 10);
      expect(places).toBeLessThanOrEqual(QUEST_BOARD.notes);
      expect(places).toBeGreaterThanOrEqual(last);
      last = places;
    }
  });

  it('keeps every quest reachable: pinned notes plus the hidden ones are all of them', () => {
    for (const height of [0, 20, 40, 60, 80, 100, 150]) {
      for (const total of [1, 2, 3, 4, 9]) {
        const items = Array.from({ length: total }, (_, index) => index);
        const { pinned, hidden } = pinNotes(items, noteCapacity(height, total));
        expect([...pinned, ...hidden]).toEqual(items);
      }
    }
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

const needsYouBubbles = (seats: Parameters<typeof needsYouGroups>[0]) =>
  new Map([...needsYouGroups(seats)].map(([id, group]) => [id, group.length]));

describe('needsYouGroups', () => {
  it('lists the agents a bubble speaks for left to right', () => {
    expect(needsYouGroups([atBar('c', 2), atBar('a', 0), atBar('b', 1)])).toEqual(new Map([['b', ['a', 'b', 'c']]]));
  });

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

describe('announcements', () => {
  describe('joinAnnouncements', () => {
    it('speaks up to three updates in full', () => {
      expect(joinAnnouncements(['A finished', 'B needs you', 'C failed'])).toBe('A finished. B needs you. C failed.');
    });

    it('folds the rest into a count past three', () => {
      expect(joinAnnouncements(['A finished', 'B needs you', 'C failed', 'D finished'])).toBe(
        'A finished. B needs you. C failed. 1 more update.'
      );
      expect(joinAnnouncements(['A finished', 'B needs you', 'C failed', 'D finished', 'E failed'])).toBe(
        'A finished. B needs you. C failed. 2 more updates.'
      );
    });
  });
});

describe('bubbleAnswer', () => {
  const call = (extra: Partial<ChatToolCall> = {}): ChatToolCall => ({
    id: 'c1',
    name: 'bash',
    input: { command: 'pnpm test' },
    status: 'awaiting-approval',
    approvalId: 'ap-1',
    ...extra,
  });

  const question = (labels: string[], extra: Partial<ChatQuestion> = {}): ChatQuestion => ({
    question: 'Which way?',
    header: 'Decision',
    options: labels.map(label => ({ label, description: `Pick ${label}` })),
    ...extra,
  });

  const decision = { via: 'decision', decisionId: 'd-1' } as const;

  describe('planForCall', () => {
    it('offers Approve / Deny for a plain approval, naming the call', () => {
      expect(planForCall(call())).toEqual({ kind: 'approve', approvalId: 'ap-1', summary: 'bash pnpm test' });
    });

    it('sends every approval that needs the full card to Open', () => {
      expect(planForCall(call({ approvalIrreversible: true })).kind).toBe('open');
      expect(planForCall(call({ name: 'request_directory', input: { path: '/x' } })).kind).toBe('open');
      expect(planForCall(call({ approvalChoice: { options: [{ id: 'a', label: 'A', description: '' }] } })).kind).toBe(
        'open'
      );
    });

    it('is Open while nothing is parked yet', () => {
      expect(planForCall(undefined)).toEqual({ kind: 'open' });
    });

    it('answers a one-question ask_user card through the approval it is parked on', () => {
      const plan = planForCall(
        call({ name: 'ask_user', input: { questions: [question(['Yes (Recommended)', 'No'])] } })
      );
      expect(plan).toMatchObject({
        kind: 'choose',
        target: { via: 'approval', approvalId: 'ap-1' },
        options: [
          { label: 'Yes (Recommended)', face: 'Yes', recommended: true },
          { label: 'No', face: 'No', recommended: false },
        ],
      });
    });

    it('opens an ask_user card with more than one question', () => {
      const questions = [question(['A', 'B']), { ...question(['C', 'D']), question: 'And?' }];
      expect(planForCall(call({ name: 'ask_user', input: { questions } })).kind).toBe('open');
    });
  });

  describe('planForQuestion', () => {
    it('draws short single-choice options as buttons', () => {
      expect(planForQuestion(question(['Ship it', 'Wait']), decision)).toMatchObject({
        kind: 'choose',
        prompt: 'Which way?',
        target: decision,
      });
    });

    it('falls back to Open for multi-select, long or destructive options', () => {
      expect(planForQuestion(question(['A', 'B'], { multiSelect: true }), decision).kind).toBe('open');
      expect(planForQuestion(question(['A', 'x'.repeat(BUBBLE_OPTION_MAX + 1)]), decision).kind).toBe('open');
      expect(planForQuestion(question(['Keep the branch', 'Delete the branch']), decision)).toEqual({
        kind: 'open',
        prompt: 'Which way?',
      });
    });
  });
});

describe('innkeeper', () => {
  const agent = (id: string, state: AgentState): AgentView => ({
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

  const tool = (name: string, target?: string): AgentActivity => ({ kind: 'tool', tool: name, detail: '', target });
  const thinking: AgentActivity = { kind: 'phase', phase: 'thinking' };

  describe('innkeeperAct', () => {
    it('polishes the bar while the parent is not processing', () => {
      expect(innkeeperAct({ status: 'done' }, [agent('a', 'working')])).toEqual({ pose: 'idle' });
      expect(innkeeperAct({}, [])).toEqual({ pose: 'idle' });
    });

    it('writes while posting quests, and while thinking before any agent exists', () => {
      expect(innkeeperAct({ status: 'processing', activity: tool('session_spawn') }, [agent('a', 'working')])).toEqual({
        pose: 'writing',
      });
      expect(innkeeperAct({ status: 'processing', activity: thinking }, [])).toEqual({ pose: 'writing' });
      expect(innkeeperAct({ status: 'processing' }, [])).toEqual({ pose: 'writing' });
    });

    it('walks to the agent a session_read or session_send names', () => {
      const agents = [agent('a', 'working'), agent('b', 'done')];
      expect(innkeeperAct({ status: 'processing', activity: tool('session_read', 'b') }, agents)).toEqual({
        pose: 'walking',
        target: 'b',
      });
      expect(innkeeperAct({ status: 'processing', activity: tool('session_send', 'a') }, agents)).toEqual({
        pose: 'walking',
        target: 'a',
      });
    });

    it('does not walk to a session that is not in the roster', () => {
      expect(
        innkeeperAct({ status: 'processing', activity: tool('session_read', 'stranger') }, [agent('a', 'working')])
      ).toEqual({ pose: 'idle' });
    });

    it('reads once every agent has settled and the parent is still processing', () => {
      const settled = [agent('a', 'done'), agent('b', 'failed'), agent('c', 'stopped'), agent('d', 'idle')];
      expect(innkeeperAct({ status: 'processing', activity: thinking }, settled)).toEqual({ pose: 'reading' });
      expect(innkeeperAct({ status: 'processing' }, [...settled, agent('e', 'needs-you')])).toEqual({ pose: 'idle' });
    });
  });

  describe('innkeeperBubble', () => {
    it("shows the parent's live activity while busy, and asks for the user when it needs them", () => {
      expect(innkeeperBubble({ status: 'processing', activity: tool('session_spawn') })).toBe('session_spawn');
      expect(innkeeperBubble({ status: 'processing', activity: thinking })).toBe('Thinking');
      expect(innkeeperBubble({ status: 'needs-action' })).toBe('Needs you!');
      expect(innkeeperBubble({ status: 'done', activity: thinking })).toBeUndefined();
      expect(innkeeperBubble({ status: 'processing' })).toBeUndefined();
    });
  });
});

describe('quests', () => {
  // testUtils needs a DOM; these helpers only read id, title, state and workerTask.
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

  const LATER = '2026-10-01T00:05:00.000Z';
  /** An agent whose run ended and whose outcome has been stored, which updates its record. */
  const ended = (id: string, state: AgentState, outcome: AgentView['outcome']) =>
    agent(id, state, { outcome, updatedAt: LATER });

  /** A worker task in the given state: only `state.status` and `accepted` matter to the board. */
  const withTask = (status: string, accepted?: boolean) =>
    ({
      workerTask: { state: { status, ...(accepted === undefined ? {} : { accepted }) } },
    }) as unknown as Partial<AgentView>;
  /** A needs-you waiting on the user in the Task panel: the task already holds its own run's outcome. */
  const waiting = (id: string, outcome: AgentView['outcome'], status = 'completed') =>
    agent(id, 'needs-you', {
      outcome,
      updatedAt: LATER,
      ...withTask(status, status === 'completed' ? false : undefined),
    });
  const accepted = (id: string) =>
    agent(id, 'done', { outcome: 'finished', updatedAt: LATER, ...withTask('completed', true) });

  const withOutcome = (outcome: string) => ({ workerTask: { contract: { outcome } } }) as unknown as Partial<AgentView>;

  describe('questTitle', () => {
    it("takes the first line of the task contract's outcome", () => {
      expect(questTitle(agent('a', 'working', withOutcome('  Fix the login flow\nThen add tests')))).toBe(
        'Fix the login flow'
      );
    });

    it('falls back to the session title without a contract, or with a blank outcome', () => {
      expect(questTitle(agent('a', 'working'))).toBe('Agent a');
      expect(questTitle(agent('a', 'working', withOutcome('   ')))).toBe('Agent a');
    });
  });

  describe('trackQuests', () => {
    const track = (steps: AgentView[][]) =>
      steps.reduce((ledger, agents, index) => trackQuests(ledger, agents, index * 100), EMPTY_LEDGER);

    it('checks off an open quest the moment its agent turns done', () => {
      const ledger = track([
        [agent('a', 'working'), agent('b', 'needs-you')],
        [agent('a', 'done'), agent('b', 'done')],
      ]);
      expect(ledger.finished).toEqual(
        new Map([
          ['a', 100],
          ['b', 100],
        ])
      );
      expect(ledger.open.size).toBe(0);
    });

    it('still checks it off when the agent reads idle between working and done', () => {
      const ledger = track([[agent('a', 'working')], [agent('a', 'idle')], [agent('a', 'done')]]);
      expect(ledger.finished).toEqual(new Map([['a', 200]]));
    });

    it("keeps a re-run open while it still reads as the previous run's outcome", () => {
      for (const [state, outcome] of [
        ['failed', 'failed'],
        ['stopped', 'aborted'],
      ] as const) {
        const ledger = track([
          [agent('a', 'working', { outcome })],
          [agent('a', state, { outcome })],
          [ended('a', 'done', 'finished')],
        ]);
        expect(ledger.finished).toEqual(new Map([['a', 200]]));
      }
    });

    it("holds a re-run open while `done` is still the previous run's finished outcome, then drops it on failure", () => {
      const ledger = track([
        [agent('a', 'working', { outcome: 'finished' })],
        [agent('a', 'done', { outcome: 'finished' })],
      ]);
      expect(ledger.finished.size).toBe(0);
      expect(ledger.open.has('a')).toBe(true);
      const failed = trackQuests(ledger, [ended('a', 'failed', 'failed')], 200);
      expect(failed.open.size).toBe(0);
      expect(failed.finished.size).toBe(0);
    });

    it('checks off a re-run once its done record is a new update', () => {
      const ledger = track([
        [agent('a', 'working', { outcome: 'finished' })],
        [agent('a', 'done', { outcome: 'finished' })],
        [ended('a', 'done', 'finished')],
      ]);
      expect(ledger.finished).toEqual(new Map([['a', 200]]));
      expect(ledger.open.size).toBe(0);
    });

    it('checks off a run the user accepts while it waits on them, even with its record unchanged', () => {
      const ledger = track([
        [agent('a', 'working', { outcome: 'finished' })],
        [waiting('a', 'finished')],
        [accepted('a')],
      ]);
      expect(ledger.finished).toEqual(new Map([['a', 200]]));
      expect(ledger.open.size).toBe(0);
    });

    it('checks off a held re-run that reaches needs-you and is then accepted', () => {
      const ledger = track([
        [agent('a', 'working', { outcome: 'finished' })],
        [agent('a', 'done', { outcome: 'finished' })],
        [waiting('a', 'finished')],
        [accepted('a')],
      ]);
      expect(ledger.finished).toEqual(new Map([['a', 300]]));
      expect(ledger.open.size).toBe(0);
    });

    it("still holds a done straight after working that reads as the previous run's outcome", () => {
      const ledger = track([
        [agent('a', 'needs-you', { outcome: 'finished' })],
        [agent('a', 'working', { outcome: 'finished' })],
        [agent('a', 'done', { outcome: 'finished' })],
        [agent('a', 'done', { outcome: 'finished' })],
      ]);
      expect(ledger.finished.size).toBe(0);
      expect(ledger.open.has('a')).toBe(true);
    });

    it('ends a run the user stops while it waits on them, even with its record unchanged', () => {
      const ledger = track([[waiting('a', 'aborted', 'blocked')], [ended('a', 'stopped', 'aborted')]]);
      expect(ledger.open.size).toBe(0);
      expect(ledger.finished.size).toBe(0);
    });

    it('holds a re-run open at every step through a live approval and a stale done', () => {
      for (const live of [{}, withTask('running')]) {
        let ledger = EMPTY_LEDGER;
        const steps = [
          agent('a', 'working', { outcome: 'finished' }),
          agent('a', 'needs-you', { outcome: 'finished', ...live }),
          agent('a', 'done', { outcome: 'finished' }),
          agent('a', 'working', { outcome: 'finished' }),
        ];
        steps.forEach((step, index) => {
          ledger = trackQuests(ledger, [step], index * 100);
          expect(ledger.finished.size).toBe(0);
          expect(ledger.open.has('a')).toBe(true);
        });
      }
    });

    it('keeps a first run open when a live approval clears to idle with the record unchanged', () => {
      const ledger = track([[agent('a', 'working')], [agent('a', 'needs-you')], [agent('a', 'idle')]]);
      expect(ledger.open.has('a')).toBe(true);
      expect(ledger.finished.size).toBe(0);
    });

    it('ends a re-run that fails again with the same outcome once the record updates', () => {
      const ledger = track([[agent('a', 'working', { outcome: 'failed' })], [ended('a', 'failed', 'failed')]]);
      expect(ledger.open.size).toBe(0);
    });

    it('never adds an agent already done, or one whose quest failed or stopped', () => {
      const ledger = track([
        [agent('a', 'done'), agent('b', 'working'), agent('c', 'idle'), agent('d', 'working')],
        [agent('a', 'done'), ended('b', 'failed', 'failed'), agent('c', 'done'), ended('d', 'stopped', 'aborted')],
        [agent('a', 'done'), agent('b', 'done'), agent('c', 'done'), agent('d', 'done')],
      ]);
      expect(ledger.finished.size).toBe(0);
    });

    it('keeps the first finish time, and forgets an agent that takes up a quest again or leaves', () => {
      const ledger = track([
        [agent('a', 'working'), agent('b', 'working'), agent('c', 'working')],
        [agent('a', 'done'), agent('b', 'done'), agent('c', 'done')],
        [agent('a', 'done'), agent('b', 'working')],
      ]);
      expect(ledger.finished).toEqual(new Map([['a', 100]]));
      expect([...ledger.open.keys()]).toEqual(['b']);
    });
  });

  describe('takeDown', () => {
    it('drops a finished quest once it has lingered long enough', () => {
      const finished = new Map([
        ['old', 0],
        ['new', 10],
      ]);
      expect(takeDown(finished, QUEST_DONE_LINGER_MS)).toEqual(new Map([['new', 10]]));
    });
  });

  describe('questNotes', () => {
    it('pins open quests, one on its way to done, and lingering finished ones, in roster order', () => {
      const before = [agent('b', 'working'), agent('c', 'working'), agent('d', 'needs-you'), agent('f', 'working')];
      const after = [
        agent('a', 'done'),
        agent('b', 'working'),
        agent('c', 'idle'),
        agent('d', 'needs-you'),
        agent('e', 'idle', { outcome: 'no-reply' }),
        agent('f', 'done'),
      ];
      const ledger = trackQuests(trackQuests(EMPTY_LEDGER, before, 0), after, 10);
      expect(questNotes(after, ledger).map(note => [note.agent.id, note.done])).toEqual([
        ['b', false],
        ['c', false],
        ['d', false],
        ['f', true],
      ]);
      expect(questNotes(after, ledger).find(note => note.done)?.finishedAt).toBe(10);
    });

    it('drops a quest whose run ended with no reply', () => {
      const ledger = trackQuests(
        trackQuests(EMPTY_LEDGER, [agent('a', 'working')], 0),
        [agent('a', 'idle', { outcome: 'no-reply' })],
        10
      );
      expect(ledger.open.size).toBe(0);
    });
  });
});
