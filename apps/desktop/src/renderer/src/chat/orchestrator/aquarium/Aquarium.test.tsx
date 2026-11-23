// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewSnapshot } from '@shared/viewSnapshot';
import { createThemedMount, el, query, snapshotFixture, viewAgentFixture } from '../testUtils';
import { Aquarium } from './Aquarium';

const themed = createThemedMount();
const onAction = vi.fn();

afterEach(() => {
  themed.unmount();
  onAction.mockReset();
});

const renderTank = (snapshot: ViewSnapshot) => themed.render(<Aquarium snapshot={snapshot} onAction={onAction} />);
const fish = (id: string) => el(`orchestrator-fish-${id}`);
const bubblesOf = (id: string) =>
  fish(id).parentElement?.querySelector('[data-testid="orchestrator-fish-bubbles"]') ?? null;

describe('Aquarium', () => {
  it.each([
    ['working', 'swim', 'midwater'],
    ['done', 'rest', 'low'],
    ['failed', 'pale', 'sand'],
    ['idle', 'sleep', 'sand'],
    ['stopped', 'sleep', 'sand'],
    ['needs-you', 'front', 'glass'],
  ] as const)('draws a %s agent as a %s fish in the %s', async (state, pose, zone) => {
    await renderTank(snapshotFixture([viewAgentFixture('a', state)]));
    expect(fish('a').dataset.state).toBe(state);
    expect(fish('a').dataset.pose).toBe(pose);
    expect(fish('a').dataset.zone).toBe(zone);
  });

  it('lets bubbles rise from a fish when it is done, and only then', async () => {
    await renderTank(snapshotFixture([viewAgentFixture('a', 'working')]));
    expect(bubblesOf('a')).toBeNull();
    await renderTank(snapshotFixture([viewAgentFixture('a', 'done')]));
    expect(bubblesOf('a')).not.toBeNull();
  });

  it('keeps one element per fish across a change of state, so it glides to its new spot', async () => {
    await renderTank(snapshotFixture([viewAgentFixture('a', 'working')]));
    const before = fish('a').parentElement;
    await renderTank(snapshotFixture([viewAgentFixture('a', 'failed')]));
    expect(fish('a').parentElement).toBe(before);
  });

  it('leaves the lamp dark while nobody waits on the user', async () => {
    await renderTank(snapshotFixture([viewAgentFixture('a', 'working'), viewAgentFixture('b', 'done')]));
    expect(el('orchestrator-aquarium-lamp').dataset.lit).toBe('off');
    expect(el('orchestrator-aquarium-lamp').tagName).toBe('DIV');
  });

  it('lights the lamp when an agent needs the user, and opens that agent from it', async () => {
    await renderTank(snapshotFixture([viewAgentFixture('w', 'working'), viewAgentFixture('ask', 'needs-you')]));
    expect(el('orchestrator-aquarium-lamp').dataset.lit).toBe('on');
    expect(fish('ask').parentElement?.textContent).toContain('Agent ask');
    act(() => el('orchestrator-aquarium-lamp').click());
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-agent', agentId: 'ask' });
  });

  it('lights the lamp when the root needs the user, and opens the conversation first', async () => {
    await renderTank(snapshotFixture([viewAgentFixture('ask', 'needs-you')], 'needs-you'));
    expect(el('orchestrator-aquarium-lamp').dataset.lit).toBe('on');
    act(() => el('orchestrator-aquarium-lamp').click());
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-root' });
  });

  it('lights the lamp for the root alone, with no fish at the glass', async () => {
    await renderTank(snapshotFixture([viewAgentFixture('w', 'working')], 'needs-you'));
    expect(el('orchestrator-aquarium-lamp').dataset.lit).toBe('on');
    expect(document.querySelector('[data-zone="glass"]')).toBeNull();
    expect(el('orchestrator-aquarium').getAttribute('aria-label')).toContain('needs you');
  });

  it('opens a fish in the peek drawer when it is clicked, and labels it with its state', async () => {
    await renderTank(snapshotFixture([viewAgentFixture('a', 'failed', { now: 'Hit the context limit' })]));
    expect(fish('a').getAttribute('aria-label')).toBe('Agent a: Failed');
    expect(fish('a').getAttribute('title')).toContain('Hit the context limit');
    act(() => fish('a').click());
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-agent', agentId: 'a' });
  });

  it('draws nothing but the lamp for an empty tank', async () => {
    await renderTank(snapshotFixture([]));
    expect(query('orchestrator-aquarium')?.querySelector('[data-testid^="orchestrator-fish-"]')).toBeNull();
  });

  it('builds on the snapshot contract alone', () => {
    const allowed =
      /^(react|@mui\/.+|@shared\/viewSnapshot|@shared\/agentState|\.\.\/AgentPrIndicator|\.\/[\w]+|\.\.\/\.\.\/\.\.\/assets\/.+)$/;
    const sources = import.meta.glob<string>(['./*.{ts,tsx}', '!./*.test.{ts,tsx}'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    expect(Object.keys(sources).sort()).toEqual(['./Aquarium.tsx', './aquariumArt.ts', './aquariumScene.ts']);
    for (const [name, source] of Object.entries(sources)) {
      const imports = [...source.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
      expect(
        imports.filter(specifier => !allowed.test(specifier)),
        name
      ).toEqual([]);
    }
  });
});
