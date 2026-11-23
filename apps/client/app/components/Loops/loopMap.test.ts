import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import type { ILoopStageStats } from '@bike4mind/common';
import { buildLoopMap, formatDuration, mapLabel } from './loopMap';

const HOUR = 60 * 60 * 1000;
const row = (stage: string, overrides: Partial<ILoopStageStats> = {}) =>
  ({ stage, entered: 0, backMoves: 0, medianTimeInStageMs: null, ...overrides }) as ILoopStageStats;

const input = {
  loop: {
    name: 'Factory',
    stages: ['todo', 'build', 'done'],
    stageConfig: [{ stage: 'build', runner: 'desktop' as const }],
  },
  stageCounts: { todo: 3, build: 1, done: 7 },
  byStage: [row('todo', { medianTimeInStageMs: 2 * HOUR }), row('build', { entered: 4, backMoves: 2 }), row('done')],
  needsYou: 2,
  overseers: [{ name: 'Overseer' }],
  workers: [],
  handoffTargets: [{ name: 'QA' }],
};

describe('mapLabel', () => {
  it('turns every character that could break mermaid syntax into an entity code', () => {
    expect(mapLabel('a "b" [c] {d} <e> |f|; #g')).toBe(
      '"a #34;b#34; #91;c#93; #123;d#125; #60;e#62; #124;f#124;#59; #35;g"'
    );
  });
});

describe('buildLoopMap', () => {
  it('draws one node per stage with its runner and live count, edge figures, the gate and Needs you', () => {
    const map = buildLoopMap(input);
    expect(map).toContain('s0["todo (cloud) - 3"]');
    expect(map).toContain('s1["build (desktop) - 1"]');
    expect(map).toContain('s2["done (closed) - 7"]');
    expect(map).toContain('s0 -->|"4 entered / 2h"| s1');
    expect(map).toContain('s1 -->|"0 entered"| s2');
    expect(map).toContain('s1 -.->|"2 back"| s0');
    expect(map).toContain('g1{{"human gate"}} -.- s1');
    expect(map).toContain('needs(("Needs you (2)"))');
    expect(map).toContain('o0["Overseer"] -.->|oversees| loop');
    expect(map).toContain('loop -.->|hand-off| h0["QA"]');
  });

  it('marks no gate on a desktop stage that merges on green CI, and plain edges without stats', () => {
    const map = buildLoopMap({
      ...input,
      loop: { ...input.loop, stageConfig: [{ stage: 'build', runner: 'desktop', mergePolicy: 'green-ci' }] },
      byStage: undefined,
    });
    expect(map).not.toContain('human gate');
    expect(map).toContain('s0 --> s1');
    expect(map).not.toContain('back');
  });

  it('produces a chart mermaid parses, even with quotes and brackets in owner text', async () => {
    const map = buildLoopMap({
      ...input,
      loop: { ...input.loop, name: 'Ship "it" [now]', stages: ['to "do"', 'build [x]', 'done; end'] },
      stageCounts: {},
      byStage: undefined,
      handoffTargets: [{ name: 'Q|A {team}' }],
    });
    expect(map).toContain('s0["to #34;do#34; (cloud) - 0"]');
    await expect(mermaid.parse(map)).resolves.toBeTruthy();
  });
});

describe('formatDuration', () => {
  it.each([
    [30_000, '1m'],
    [45 * 60_000, '45m'],
    [5 * HOUR, '5h'],
    [72 * HOUR, '3d'],
  ])('%i ms -> %s', (ms, label) => {
    expect(formatDuration(ms)).toBe(label);
  });
});
