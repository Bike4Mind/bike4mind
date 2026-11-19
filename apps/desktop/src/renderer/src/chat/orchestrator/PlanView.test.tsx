// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanView } from './PlanView';
import { createThemedMount, el, query, snapshotFixture, viewAgentFixture } from './testUtils';

const themed = createThemedMount();
const onAction = vi.fn();

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
});

const show = (...agents: Parameters<typeof snapshotFixture>[0]) =>
  themed.render(<PlanView snapshot={snapshotFixture(agents)} onAction={onAction} />);

describe('PlanView', () => {
  it('says so when there are no agents', async () => {
    await show();
    expect(el('plan-view-no-agents').textContent).toBe('No agents yet');
  });

  it('shows "No plan yet" for an agent without a plan or with an empty one', async () => {
    await show(viewAgentFixture('a', 'working'), viewAgentFixture('b', 'working', { plan: { done: 0, total: 0 } }));
    expect(el('plan-view-row-a').querySelector('[data-testid="plan-view-empty-plan"]')?.textContent).toBe(
      'No plan yet'
    );
    expect(el('plan-view-row-b').querySelector('[data-testid="plan-view-empty-plan"]')).not.toBeNull();
  });

  it('shows done/total, the current item and the next one while in progress', async () => {
    await show(viewAgentFixture('a', 'working', { plan: { done: 1, total: 3, current: 'Wire it', next: 'Test it' } }));
    const row = el('plan-view-row-a');
    expect(row.querySelector('[data-testid="plan-view-ring"]')?.textContent).toBe('1/3');
    expect(row.querySelector('[data-testid="plan-view-current"]')?.textContent).toBe('Wire it');
    expect(row.querySelector('[data-testid="plan-view-next"]')?.textContent).toBe('Next: Test it');
  });

  it('shows the question instead of the current item when the agent needs you', async () => {
    await show(
      viewAgentFixture('a', 'needs-you', { plan: { done: 1, total: 3, current: 'Wire it', next: 'Test it' } })
    );
    const row = el('plan-view-row-a');
    expect(row.querySelector('[data-testid="plan-view-needs-you"]')?.textContent).toBe('Question from a?');
    expect(row.querySelector('[data-testid="plan-view-current"]')).toBeNull();
  });

  it('says "All done" once every item is done', async () => {
    await show(viewAgentFixture('a', 'done', { plan: { done: 2, total: 2 } }));
    expect(el('plan-view-current').textContent).toBe('All done');
    expect(query('plan-view-next')).toBeNull();
  });

  it('keeps every part, clamped, in a narrow container', async () => {
    const long = 'x'.repeat(300);
    await show(viewAgentFixture('a', 'working', { plan: { done: 0, total: 2, current: long, next: long } }));
    const root = el('plan-view-root');
    root.style.width = '240px';
    expect(el('plan-view-current').textContent).toBe(long);
    expect(el('plan-view-next')).not.toBeNull();
    expect(getComputedStyle(root).overflowX).toBe('hidden');
    expect(getComputedStyle(el('plan-view-current')).textOverflow).toBe('ellipsis');
  });

  it('opens the agent when its row is clicked', async () => {
    await show(viewAgentFixture('a', 'working'));
    el('plan-view-row-a').click();
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-agent', agentId: 'a' });
  });
});
