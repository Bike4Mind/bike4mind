// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FocusPanel } from './FocusPanel';
import type { ViewAction } from '@shared/viewSnapshot';
import { agentFixture, createThemedMount, el, query } from './testUtils';
import { toViewSnapshot } from './viewSnapshot';
import type { AgentView } from './roster';

const themed = createThemedMount();
const onAction = vi.fn<(action: ViewAction) => Promise<void>>(async () => undefined);

afterEach(() => {
  themed.unmount();
  onAction.mockClear();
});

const all = (testId: string, within: ParentNode = document) =>
  Array.from(within.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`));
const items = () => all('orchestrator-focus-item');
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
};

const decision = (labels: string[], multiSelect?: boolean): NonNullable<AgentView['decision']> => ({
  id: 'd1',
  askedAt: '2026-10-01T00:00:00.000Z',
  question: {
    question: 'Which database?',
    header: 'Decision',
    options: labels.map(label => ({ label, description: label })),
    ...(multiSelect && { multiSelect }),
  },
});

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
    expect(all('orchestrator-focus-working-row').map(row => row.textContent)).toEqual([
      expect.stringContaining('Agent w1'),
      expect.stringContaining('Agent w2'),
    ]);
    expect(el('orchestrator-focus-quiet').textContent).toBe('1 done');
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
    expect(query('orchestrator-focus-quiet')).toBeNull();
    expect(all('orchestrator-focus-working-row')).toHaveLength(1);
  });

  it('answers a pending decision with one click per option, recommended first', async () => {
    const agent = agentFixture('ask', 'needs-you', { decision: decision(['Postgres (Recommended)', 'Mongo']) });
    await themed.render(<FocusPanel snapshot={toViewSnapshot('root', [agent], {})} onAction={onAction} />);
    const options = all('orchestrator-focus-option-btn');
    expect(options.map(option => option.textContent)).toEqual(['Postgres', 'Mongo']);
    await click(options[1]);
    expect(onAction).toHaveBeenCalledWith({
      kind: 'answer',
      agentId: 'ask',
      decisionId: 'd1',
      answer: { status: 'answered', answers: [{ selected: ['Mongo'] }] },
    });
    // Sent: the options go at once, so a second click cannot answer twice.
    expect(all('orchestrator-focus-option-btn')).toHaveLength(0);
  });

  it('leaves multi-select and destructive-sounding decisions to the full card', async () => {
    const multi = agentFixture('m', 'needs-you', { decision: decision(['A', 'B'], true) });
    const risky = agentFixture('r', 'needs-you', { decision: decision(['Keep it', 'Delete the branch']) });
    await themed.render(<FocusPanel snapshot={toViewSnapshot('root', [multi, risky], {})} onAction={onAction} />);
    expect(all('orchestrator-focus-option-btn')).toHaveLength(0);
    expect(all('orchestrator-focus-open-btn')).toHaveLength(2);
  });

  it('allows once or denies a quick approval on its item', async () => {
    const snapshot = toViewSnapshot('root', [agentFixture('gate', 'needs-you')], { status: 'needs-action' }, [
      { id: 'p-root', sessionId: 'root', label: 'bash ls' },
      { id: 'p1', sessionId: 'gate', label: 'bash pnpm test' },
    ]);
    await themed.render(<FocusPanel snapshot={snapshot} onAction={onAction} />);
    const [rootItem, agentItem] = items();
    expect(all('orchestrator-focus-approval', rootItem).map(row => row.textContent)).toEqual([
      expect.stringContaining('bash ls'),
    ]);
    await click(all('orchestrator-focus-deny-btn', agentItem)[0]);
    expect(onAction).toHaveBeenCalledWith({ kind: 'approve', approvalId: 'p1', mode: 'deny' });
    expect(all('orchestrator-focus-approval', agentItem)).toHaveLength(0);
    await click(all('orchestrator-focus-allow-once-btn', rootItem)[0]);
    expect(onAction).toHaveBeenLastCalledWith({ kind: 'approve', approvalId: 'p-root', mode: 'once' });
  });

  it('brings a refused control back with the reason', async () => {
    onAction.mockRejectedValueOnce(new Error('Already answered'));
    const snapshot = toViewSnapshot('root', [agentFixture('gate', 'needs-you')], {}, [
      { id: 'p1', sessionId: 'gate', label: 'bash pnpm test' },
    ]);
    await themed.render(<FocusPanel snapshot={snapshot} onAction={onAction} />);
    await click(el('orchestrator-focus-allow-once-btn'));
    expect(el('orchestrator-focus-error').textContent).toBe('Already answered');
    expect(all('orchestrator-focus-allow-once-btn')).toHaveLength(1);
  });

  it('brings an answer or a Stop back when main refuses it', async () => {
    const agent = agentFixture('ask', 'needs-you', { decision: decision(['Postgres', 'Mongo']) });
    const busy = agentFixture('busy', 'working');
    await themed.render(<FocusPanel snapshot={toViewSnapshot('root', [agent, busy], {})} onAction={onAction} />);
    onAction.mockRejectedValueOnce(new Error('no longer pending'));
    await click(all('orchestrator-focus-option-btn')[0]);
    expect(el('orchestrator-focus-error').textContent).toBe('no longer pending');
    expect(all('orchestrator-focus-option-btn')).toHaveLength(2);

    onAction.mockRejectedValueOnce(new Error('could not stop'));
    const stop = () => el('orchestrator-focus-working-row').querySelector<HTMLElement>('button')!;
    await click(stop());
    expect(stop().hasAttribute('disabled')).toBe(false);
  });

  it('offers Stop again once the agent has moved on', async () => {
    const render = (updatedAt: string) =>
      themed.render(
        <FocusPanel
          snapshot={toViewSnapshot('root', [agentFixture('busy', 'working', { updatedAt })], {})}
          onAction={onAction}
        />
      );
    await render('2026-10-01T00:00:00.000Z');
    await click(el('orchestrator-focus-stop-btn'));
    expect(el('orchestrator-focus-stop-btn').hasAttribute('disabled')).toBe(true);
    await render('2026-10-01T00:05:00.000Z');
    expect(el('orchestrator-focus-stop-btn').hasAttribute('disabled')).toBe(false);
  });

  it('stops a working agent from its row, and a waiting one from its item', async () => {
    const snapshot = toViewSnapshot(
      'root',
      [agentFixture('ask', 'needs-you'), agentFixture('busy', 'working'), agentFixture('broke', 'failed')],
      {}
    );
    await themed.render(<FocusPanel snapshot={snapshot} onAction={onAction} />);
    const [waiting, failed] = items();
    expect(all('orchestrator-focus-stop-btn', failed)).toHaveLength(0);
    await click(all('orchestrator-focus-stop-btn', all('orchestrator-focus-working-row')[0])[0]);
    expect(onAction).toHaveBeenCalledWith({ kind: 'stop', agentId: 'busy' });
    await click(all('orchestrator-focus-stop-btn', waiting)[0]);
    expect(onAction).toHaveBeenLastCalledWith({ kind: 'stop', agentId: 'ask' });
    expect(all('orchestrator-focus-stop-btn').every(button => button.hasAttribute('disabled'))).toBe(true);
  });
});
