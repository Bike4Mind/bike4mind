// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewSnapshot } from '@shared/viewSnapshot';
import { snapshotFixture, viewAgentFixture, createThemedMount, el, query } from './testUtils';
import { TileWall } from './TileWall';

const themed = createThemedMount();
const onAction = vi.fn();

afterEach(() => {
  themed.unmount();
  onAction.mockReset();
});

const renderWall = (snapshot: ViewSnapshot) => themed.render(<TileWall snapshot={snapshot} onAction={onAction} />);

const tileOrder = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="orchestrator-tile-"][data-state]')).map(tile =>
    tile.dataset.testid?.replace('orchestrator-tile-', '')
  );

const within = (tileKey: string, testId: string) =>
  el(`orchestrator-tile-${tileKey}`).querySelector<HTMLElement>(`[data-testid="${testId}"]`);

describe('TileWall', () => {
  it('shows a working agent with its activity line and a progress hairline', async () => {
    await renderWall(snapshotFixture([viewAgentFixture('w', 'working', { now: 'Running the test suite' })]));
    expect(el('orchestrator-tile-w').dataset.state).toBe('working');
    expect(within('w', 'orchestrator-tile-line')?.textContent).toBe('Running the test suite');
    expect(within('w', 'orchestrator-tile-hairline')).not.toBeNull();
    expect(within('w', 'orchestrator-tile-dot')?.dataset.color).toBe('primary');
  });

  it('updates the activity line in place as the snapshot changes', async () => {
    await renderWall(snapshotFixture([viewAgentFixture('w', 'working', { now: 'Reading files' })]));
    await renderWall(snapshotFixture([viewAgentFixture('w', 'working', { now: 'Writing the fix' })]));
    expect(within('w', 'orchestrator-tile-line')?.textContent).toBe('Writing the fix');
  });

  it('shows a done agent with a green dot and its PR chip', async () => {
    await renderWall(snapshotFixture([viewAgentFixture('d', 'done', { pr: { number: 42, state: 'open' } })]));
    expect(within('d', 'orchestrator-tile-dot')?.dataset.color).toBe('success');
    expect(within('d', 'orchestrator-tile-pr')?.textContent).toBe('#42 open');
    expect(within('d', 'orchestrator-tile-hairline')).toBeNull();
  });

  it('shows a done agent without a PR without a chip', async () => {
    await renderWall(snapshotFixture([viewAgentFixture('d', 'done')]));
    expect(within('d', 'orchestrator-tile-pr')).toBeNull();
  });

  it('shows a failed agent with a red dot and its outcome line', async () => {
    await renderWall(snapshotFixture([viewAgentFixture('f', 'failed', { now: 'Hit the context limit' })]));
    expect(within('f', 'orchestrator-tile-dot')?.dataset.color).toBe('danger');
    expect(within('f', 'orchestrator-tile-line')?.textContent).toBe('Hit the context limit');
  });

  it('dims idle and stopped agents and sorts them last', async () => {
    await renderWall(
      snapshotFixture([
        viewAgentFixture('i', 'idle'),
        viewAgentFixture('s', 'stopped'),
        viewAgentFixture('d', 'done'),
        viewAgentFixture('w', 'working'),
      ])
    );
    expect(tileOrder()).toEqual(['w', 'd', 'i', 's']);
    expect(getComputedStyle(el('orchestrator-tile-i')).opacity).toBe('0.55');
    expect(getComputedStyle(el('orchestrator-tile-s')).opacity).toBe('0.55');
    expect(getComputedStyle(el('orchestrator-tile-w')).opacity).toBe('1');
  });

  it('puts a needs-you agent first with its pending question, and opens it in the peek drawer', async () => {
    await renderWall(
      snapshotFixture([
        viewAgentFixture('w', 'working'),
        viewAgentFixture('ask', 'needs-you'),
        viewAgentFixture('i', 'idle'),
      ])
    );
    expect(tileOrder()).toEqual(['ask', 'w', 'i']);
    expect(within('ask', 'orchestrator-tile-line')?.textContent).toBe('Question from ask?');
    expect(within('ask', 'orchestrator-tile-dot')?.dataset.color).toBe('warning');
    act(() => el('orchestrator-tile-ask').click());
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-agent', agentId: 'ask' });
  });

  it('puts the root first when it waits on the user, and opens the conversation', async () => {
    await renderWall(snapshotFixture([viewAgentFixture('ask', 'needs-you')], 'needs-you'));
    expect(tileOrder()).toEqual(['root', 'ask']);
    expect(el('orchestrator-tile-root').textContent).toContain('Waiting for your approval');
    act(() => el('orchestrator-tile-root').click());
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-root' });
  });

  it('has no root tile while the root is not waiting', async () => {
    await renderWall(snapshotFixture([viewAgentFixture('w', 'working')], 'working'));
    expect(query('orchestrator-tile-root')).toBeNull();
  });

  it('imports nothing from the stage beyond the snapshot contract', () => {
    const source = Object.values(
      import.meta.glob<string>('./TileWall.tsx', { query: '?raw', import: 'default', eager: true })
    )[0];
    // Static, side-effect and dynamic imports alike.
    const imports = [...source.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
    expect(imports).toContain('@shared/viewSnapshot');
    const allowed = /^(react|@mui\/.+|@shared\/viewSnapshot|@shared\/agentState|\.\/(statePalette|AgentPrIndicator))$/;
    expect(imports.filter(specifier => !allowed.test(specifier))).toEqual([]);
  });
});
