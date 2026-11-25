// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { snapshotFixture, viewAgentFixture, createThemedMount, el, query } from './testUtils';
import { Transit } from './Transit';
import { transitPhase } from './transitPhase';

const themed = createThemedMount();
const onAction = vi.fn();

afterEach(() => {
  themed.unmount();
  onAction.mockReset();
});

const stopOf = (id: string) =>
  el(`orchestrator-transit-agent-${id}`).closest<HTMLElement>('[data-testid^="orchestrator-transit-stop-"]');
const render = (agents: Parameters<typeof snapshotFixture>[0], root?: Parameters<typeof snapshotFixture>[1]) =>
  themed.render(<Transit snapshot={snapshotFixture(agents, root)} onAction={onAction} />);

describe('Transit', () => {
  it('draws the five stops in order', async () => {
    await render([]);
    const stops = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="orchestrator-transit-stop-"]')).map(
      stop => stop.dataset.testid?.replace('orchestrator-transit-stop-', '')
    );
    expect(stops).toEqual(['waiting', 'planning', 'working', 'reviewing', 'done']);
  });

  it('places each state at its stop', async () => {
    await render([
      viewAgentFixture('ask', 'needs-you'),
      viewAgentFixture('idle', 'idle'),
      viewAgentFixture('plan', 'working', { now: 'Thinking' }),
      viewAgentFixture('work', 'working', { now: 'file_edit a.ts' }),
      viewAgentFixture('rev', 'working', { now: 'bash_execute pnpm test' }),
      viewAgentFixture('unknown', 'working', { now: 'Frobnicating' }),
      viewAgentFixture('fin', 'done'),
    ]);
    expect(stopOf('ask')?.dataset.testid).toBe('orchestrator-transit-stop-waiting');
    expect(stopOf('idle')?.dataset.testid).toBe('orchestrator-transit-stop-waiting');
    expect(stopOf('unknown')?.dataset.testid).toBe('orchestrator-transit-stop-waiting');
    expect(stopOf('plan')?.dataset.testid).toBe('orchestrator-transit-stop-planning');
    expect(stopOf('work')?.dataset.testid).toBe('orchestrator-transit-stop-working');
    expect(stopOf('rev')?.dataset.testid).toBe('orchestrator-transit-stop-reviewing');
    expect(stopOf('fin')?.dataset.testid).toBe('orchestrator-transit-stop-done');
  });

  it('puts failed and stopped agents off the line, in their state colour', async () => {
    await render([viewAgentFixture('bad', 'failed', { now: 'Hit the limit' }), viewAgentFixture('halt', 'stopped')]);
    const off = el('orchestrator-transit-off-line');
    expect(off.contains(el('orchestrator-transit-agent-bad'))).toBe(true);
    expect(off.contains(el('orchestrator-transit-agent-halt'))).toBe(true);
    expect(stopOf('bad')).toBeNull();
    const dot = (id: string) =>
      el(`orchestrator-transit-agent-${id}`).querySelector('[data-testid="orchestrator-transit-dot"]');
    expect(dot('bad')?.getAttribute('data-color')).toBe('danger');
    expect(dot('halt')?.getAttribute('data-color')).toBe('neutral');
  });

  it('shows the pending question for an agent that needs the user, and opens agents', async () => {
    await render([viewAgentFixture('ask', 'needs-you')], 'needs-you');
    expect(el('orchestrator-transit-agent-ask').textContent).toContain('Question from ask?');
    act(() => el('orchestrator-transit-agent-ask').click());
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-agent', agentId: 'ask' });
    act(() => el('orchestrator-transit-agent-root').click());
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-root' });
  });

  it('has no off-line area when everyone is on the line', async () => {
    await render([viewAgentFixture('a', 'done')], 'working');
    expect(query('orchestrator-transit-off-line')).toBeNull();
    expect(query('orchestrator-transit-agent-root')).toBeNull();
  });

  it('says so when there are no agents', async () => {
    await render([], 'idle');
    expect(el('orchestrator-transit-empty').textContent).toBe('No agents yet');
  });
});

describe('transitPhase', () => {
  describe('transitPhase', () => {
    it.each([
      ['done', 'done'],
      ['failed', 'off-line'],
      ['stopped', 'off-line'],
      ['needs-you', 'waiting'],
      ['idle', 'waiting'],
    ] as const)('puts a %s agent at %s whatever its text says', (state, expected) => {
      expect(transitPhase(state)).toBe(expected);
      expect(transitPhase(state, 'file_edit a.ts')).toBe(expected);
    });

    it.each([
      ['Thinking', 'planning'],
      ['Planning the change', 'planning'],
      ['file_edit app.ts', 'working'],
      ['file_write app.ts', 'working'],
      ['file_read README.md', 'working'],
      ['bash_execute pnpm build', 'working'],
      ['grep_search useState', 'working'],
      ['Writing a reply', 'working'],
      ['Preparing file_edit', 'working'],
      ['bash_execute pnpm test', 'reviewing'],
      ['bash_execute pnpm typecheck', 'reviewing'],
      ['file_edit check.ts', 'working'],
      ['file_read lint.config.ts', 'working'],
      ['file_write test.ts', 'working'],
    ] as const)('reads a working agent doing "%s" as %s', (text, expected) => {
      expect(transitPhase('working', text)).toBe(expected);
    });

    it.each([undefined, '', '   ', 'Waiting on the model', 'Starting up', 'Frobnicating'])(
      'sends a working agent with unknown activity %j to Waiting',
      text => {
        expect(transitPhase('working', text)).toBe('waiting');
      }
    );
  });
});
