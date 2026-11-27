// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assignPersonas } from '@shared/agentPersona';
import type { OrchestratorViewProps } from '../OrchestratorStage';
import type { AgentState, AgentView } from '../roster';
import { assignSheets } from '../scene/cast';
import { placeAgents, placementMap } from '../scene/placement';
import { SceneStage } from '../scene/SceneStage';
import { sceneDefinitionSchema } from '../scene/sceneDefinition';
import { UNFOCUSED_PAUSE_MS } from '../scene/useScenePause';
import { agentFixture, createThemedMount, el, query } from '../testUtils';
import { FISH_CAST, KEEPER_ART } from './aquariumArt';
import { AQUARIUM_SCENE } from './aquariumScene';
import { chatBackedHostBridge } from '../../../__fixtures__/chatBackedHostBridge';

const mount = createThemedMount('dark');
const { map, cast, states } = AQUARIUM_SCENE;
const fish = (id: string) => el(`orchestrator-aquarium-agent-${id}`);
const art = (id: string) => fish(id).querySelector('img');
// The backdrop's plants fill the outer sixth on each side (assets README).
const OPEN_WATER = { from: 100 / 6, to: 100 - 100 / 6 };
const FISH_WIDTH = (cast.spriteHeight * map.aspect.height) / map.aspect.width;

function props(agents: AgentView[], extra: Partial<OrchestratorViewProps> = {}): OrchestratorViewProps {
  return {
    agents,
    onSelect: vi.fn(),
    selectedId: null,
    introPlaying: false,
    personas: assignPersonas(agents),
    ...extra,
  };
}

const render = (view: OrchestratorViewProps) => mount.render(<SceneStage {...view} scene={AQUARIUM_SCENE} />);

beforeEach(() => {
  (window as unknown as { b4m: unknown }).b4m = {
    host: chatBackedHostBridge(),
    chat: {
      getSession: vi.fn().mockResolvedValue(null),
      getHeldRelays: vi.fn().mockResolvedValue([]),
      onStreamEvent: vi.fn(() => () => undefined),
      onQueueChanged: vi.fn(() => () => undefined),
    },
  };
});

afterEach(() => {
  mount.unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('AQUARIUM_SCENE', () => {
  it('is a valid scene definition', () => {
    expect(sceneDefinitionSchema.safeParse(AQUARIUM_SCENE).success).toBe(true);
  });

  it.each([
    ['working', 'swim', 'midwater'],
    ['waiting', 'rest', 'midwater'],
    ['done', 'rest', 'low'],
    ['failed', 'pale', 'sand'],
    ['paused', 'sleep', 'sand'],
    ['idle', 'sleep', 'sand'],
    ['stopped', 'sleep', 'sand'],
    ['needs-you', 'front', 'glass'],
  ] as const)('keeps a %s agent as a %s fish in the %s', (state: AgentState, pose, zone) => {
    expect(states.pose[state]).toBe(pose);
    expect(states.zone[state]).toBe(zone);
  });

  it('seats every fish, and stacks every overflow, in the open water between the plants', () => {
    const points = Object.values(map.zones).flatMap(zone => [...zone.slots, zone.overflow]);
    for (const point of points) {
      expect(point.y).toBeGreaterThan(20);
      expect(point.y).toBeLessThan(100);
    }
    for (const point of Object.values(map.zones).flatMap(zone => zone.slots)) {
      expect(point.x - FISH_WIDTH / 2).toBeGreaterThanOrEqual(OPEN_WATER.from);
      expect(point.x + FISH_WIDTH / 2).toBeLessThanOrEqual(OPEN_WATER.to);
    }
  });

  it('swims every lane inside the open water, one lane per swimmer', () => {
    const reach = cast.roam?.reach ?? 0;
    const lanes = map.zones.midwater.slots;
    expect(new Set(lanes.map(({ x, y }) => `${x},${y}`)).size).toBe(lanes.length);
    for (const { x } of lanes) {
      expect(x - reach).toBeGreaterThanOrEqual(OPEN_WATER.from);
      expect(x + reach).toBeLessThanOrEqual(OPEN_WATER.to);
    }
  });

  it('never seats two fish of a row closer than a fish is wide', () => {
    for (const zone of Object.values(map.zones)) {
      for (const y of new Set(zone.slots.map(slot => slot.y))) {
        const xs = zone.slots
          .filter(slot => slot.y === y)
          .map(slot => slot.x)
          .sort((a, b) => a - b);
        xs.slice(1).forEach((x, index) => expect(x - xs[index]).toBeGreaterThanOrEqual(FISH_WIDTH));
      }
    }
  });

  it('gives sixteen fish sixteen different looks before any repeats', () => {
    expect(new Set(FISH_CAST.map(sheet => `${sheet.sprites.swim}@${sheet.hue}`)).size).toBe(16);
    const agents = Array.from({ length: 16 }, (_, index) => ({ id: `a${index}`, createdAt: `2026-11-${10 + index}` }));
    const sheets = assignSheets(
      agents,
      cast.sheets.map(sheet => sheet.craft)
    );
    expect(new Set(sheets.values()).size).toBe(16);
  });

  it('seats a needs-you fish elsewhere once the glass is full, never in a stack', () => {
    const agents = Array.from({ length: 7 }, (_, index) => agentFixture(`n${index}`, 'needs-you'));
    const placements = placeAgents(agents, new Map(), placementMap(AQUARIUM_SCENE));
    expect([...placements.values()].every(placement => placement.kind === 'seat')).toBe(true);
    expect([...placements.values()].filter(placement => placement.kind === 'seat' && placement.borrowed)).toHaveLength(
      7 - map.zones.glass.slots.length
    );
  });
});

describe('the Aquarium on the scene framework', () => {
  it('draws each fish in its pose, from its own sheet', async () => {
    await render(props([agentFixture('w', 'working'), agentFixture('f', 'failed')]));
    expect(cast.sheets.some(sheet => sheet.sprites.swim === art('w')?.getAttribute('src'))).toBe(true);
    expect(cast.sheets.some(sheet => sheet.sprites.pale === art('f')?.getAttribute('src'))).toBe(true);
    expect(fish('f').getAttribute('aria-label')).toContain('Failed');
  });

  it('swims working fish across their lane, and leaves resting ones where they are', async () => {
    await render(props([agentFixture('w', 'working'), agentFixture('r', 'waiting')]));
    expect(fish('w').style.getPropertyValue('--roam-reach')).toBe(`${cast.roam?.reach}cqw`);
    expect(fish('r').style.getPropertyValue('--roam-reach')).toBe('');
  });

  it('tints a fish drawn from a hued sheet, and leaves the drawn colours alone', async () => {
    // Sixteen seats: the sand, the low water and one lane.
    const agents = Array.from({ length: 16 }, (_, index) =>
      agentFixture(`a${index}`, index < 8 ? 'idle' : index < 15 ? 'done' : 'working')
    );
    await render(props(agents));
    const filters = agents.map(agent => getComputedStyle(art(agent.id) as HTMLElement).filter);
    expect(filters.filter(filter => filter.includes('hue-rotate'))).toHaveLength(12);
  });

  it('veils the backdrop to keep the tank low in contrast', async () => {
    await render(props([agentFixture('a', 'working')]));
    expect(getComputedStyle(el('orchestrator-aquarium-veil')).backgroundColor).toBe('rgba(8, 22, 30, 0.28)');
  });

  it('keeps swimming while the window is unfocused, and stops while it is hidden', async () => {
    vi.useFakeTimers();
    await render(props([agentFixture('a', 'working')]));
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      vi.advanceTimersByTime(UNFOCUSED_PAUSE_MS + 1);
    });
    expect(el('orchestrator-aquarium-frame').dataset.paused).toBeUndefined();
    await act(async () => {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(el('orchestrator-aquarium-frame').dataset.paused).toBe('hidden');
  });

  it('keeps the Keeper on its rock, and cheers it at the finale', async () => {
    await render(props([agentFixture('a', 'done')]));
    const host = el('orchestrator-aquarium-host');
    expect(host.style.left).toBe(`${map.host.x}%`);
    expect(host.getAttribute('title')).toContain('Keeper');
    await render(props([agentFixture('a', 'done')], { celebrating: true }));
    expect(el('orchestrator-aquarium-host-art').getAttribute('src')).toBe(KEEPER_ART.cheering);
    expect(fish('a').dataset.cheering).toBe('true');
  });

  it('pins open work on its slate, in its own words', async () => {
    await render(props([agentFixture('a', 'working')]));
    expect(el('orchestrator-aquarium-quest-board').getAttribute('aria-label')).toBe('Task slate: 1 open task');
  });

  it('answers in a bubble at the glass', async () => {
    await render(props([agentFixture('n', 'needs-you')]));
    expect(query('orchestrator-aquarium-bubble-n-open')).not.toBeNull();
  });

  it('draws hundreds of fish with every seat used once and the rest stacked', async () => {
    const agents = Array.from({ length: 300 }, (_, index) => agentFixture(`a${index}`, 'working'));
    await render(props(agents));
    const seats = map.zones.midwater.slots.length;
    expect(document.querySelectorAll('[data-testid^="orchestrator-aquarium-agent-"]')).toHaveLength(seats);
    expect(el('orchestrator-aquarium-overflow-midwater').textContent).toBe(`+${300 - seats}`);
  });
});
