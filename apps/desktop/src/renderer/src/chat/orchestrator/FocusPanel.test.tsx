// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FocusPanel } from './FocusPanel';
import { agentFixture, createThemedMount, el, query } from './testUtils';
import { toViewSnapshot } from './viewSnapshot';

const themed = createThemedMount();
const onAction = vi.fn();

afterEach(() => {
  themed.unmount();
  onAction.mockReset();
});

const items = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="orchestrator-focus-item"]'));

describe('FocusPanel', () => {
  it('shows only what needs the user and counts the rest', async () => {
    const snapshot = toViewSnapshot(
      'root',
      [
        agentFixture('ask', 'needs-you'),
        agentFixture('w1', 'working'),
        agentFixture('w2', 'working'),
        agentFixture('broke', 'failed', { lastSnippet: 'Hit the context limit' }),
        agentFixture('ok', 'done'),
      ],
      {}
    );
    await themed.render(<FocusPanel snapshot={snapshot} onAction={onAction} />);
    expect(items().map(item => item.textContent)).toEqual([
      expect.stringContaining('Agent ask'),
      expect.stringContaining('Hit the context limit'),
    ]);
    expect(items().map(item => item.dataset.color)).toEqual(['warning', 'danger']);
    expect(el('orchestrator-focus-quiet').textContent).toBe('2 working \u00B7 1 done');
  });

  it('puts the orchestrator first when it waits on the user, and opens it', async () => {
    const snapshot = toViewSnapshot('root', [agentFixture('ask', 'needs-you')], { status: 'needs-action' });
    await themed.render(<FocusPanel snapshot={snapshot} onAction={onAction} />);
    expect(items()).toHaveLength(2);
    act(() => items()[0].querySelector<HTMLElement>('[data-testid="orchestrator-focus-open-btn"]')!.click());
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-root' });
    act(() => items()[1].querySelector<HTMLElement>('[data-testid="orchestrator-focus-open-btn"]')!.click());
    expect(onAction).toHaveBeenLastCalledWith({ kind: 'open-agent', agentId: 'ask' });
  });

  it('says so when nothing needs the user', async () => {
    const snapshot = toViewSnapshot('root', [agentFixture('w', 'working')], {});
    await themed.render(<FocusPanel snapshot={snapshot} onAction={onAction} />);
    expect(query('orchestrator-focus-empty')).not.toBeNull();
    expect(items()).toHaveLength(0);
    expect(el('orchestrator-focus-quiet').textContent).toBe('1 working');
  });
});
