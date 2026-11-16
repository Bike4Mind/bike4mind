// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { snapshotFixture, viewAgentFixture } from '../testUtils';
import { fishLook, FISH_LOOKS } from './aquariumArt';
import { MIDWATER_LANE, lampAction, placeFish } from './aquariumScene';

describe('placeFish', () => {
  it('keeps every fish inside the open water between the plants', () => {
    const states = ['working', 'done', 'failed', 'idle', 'stopped', 'needs-you'] as const;
    const agents = states.flatMap(state => [1, 2, 3].map(n => viewAgentFixture(`${state}-${n}`, state)));
    for (const placement of placeFish(agents)) {
      expect(placement.x).toBeGreaterThanOrEqual(MIDWATER_LANE.from - 5);
      expect(placement.x).toBeLessThanOrEqual(MIDWATER_LANE.to + 5);
      expect(placement.y).toBeGreaterThan(20);
      expect(placement.y).toBeLessThan(100);
    }
  });

  it('gives swimmers their own lanes and out-of-step lengths', () => {
    const placements = placeFish([viewAgentFixture('a', 'working'), viewAgentFixture('b', 'working')]);
    expect(new Set(placements.map(placement => placement.y)).size).toBe(2);
    for (const { swim } of placements) {
      expect(swim?.durationS).toBeGreaterThanOrEqual(22);
      expect(swim?.delayS).toBeLessThanOrEqual(0);
    }
  });

  it('keeps a resting fish in its spot while fish in other zones come and go', () => {
    const sleeper = viewAgentFixture('s', 'idle');
    const alone = placeFish([sleeper]).find(placement => placement.agent.id === 's');
    const crowded = placeFish([sleeper, viewAgentFixture('w', 'working'), viewAgentFixture('d', 'done')]).find(
      placement => placement.agent.id === 's'
    );
    expect(crowded?.x).toBe(alone?.x);
  });
});

describe('lampAction', () => {
  it('is dark with nobody waiting, opens the root first, then the first agent asking', () => {
    expect(lampAction(snapshotFixture([viewAgentFixture('w', 'working')]))).toBeUndefined();
    expect(lampAction(snapshotFixture([viewAgentFixture('a', 'needs-you')], 'needs-you'))).toEqual({
      kind: 'open-root',
    });
    expect(lampAction(snapshotFixture([viewAgentFixture('a', 'needs-you')]))).toEqual({
      kind: 'open-agent',
      agentId: 'a',
    });
  });
});

describe('fishLook', () => {
  it('is stable per agent and spreads agents over every look', () => {
    expect(fishLook('agent-1')).toEqual(fishLook('agent-1'));
    const looks = new Set(
      Array.from({ length: 400 }, (_, n) => {
        const look = fishLook(`agent-${n}`);
        return `${look.sheet}:${look.hue}`;
      })
    );
    expect(looks.size).toBe(FISH_LOOKS);
  });
});
