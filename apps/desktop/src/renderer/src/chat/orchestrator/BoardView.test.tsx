// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityLabel } from './activity';
import { BoardView } from './BoardView';
import type { AgentView } from './roster';
import { agentFixture, createThemedMount, el, query } from './testUtils';

const onSelect = vi.fn();
const themed = createThemedMount();

const renderBoard = (agents: AgentView[]) =>
  themed.render(<BoardView agents={agents} onSelect={onSelect} selectedId={null} introPlaying={false} />);

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
});

describe('BoardView', () => {
  it('puts stopped and idle agents in Done with a muted state chip', async () => {
    await renderBoard([agentFixture('a', 'stopped'), agentFixture('b', 'idle'), agentFixture('c', 'done')]);
    const done = el('orchestrator-board-column-done');
    expect(done.contains(el('orchestrator-board-card-a'))).toBe(true);
    expect(done.contains(el('orchestrator-board-card-b'))).toBe(true);
    expect(el('orchestrator-board-card-a').textContent).toContain('Stopped');
    expect(el('orchestrator-board-card-b').textContent).toContain('Idle');
  });

  it('shows a count per column header', async () => {
    await renderBoard([
      agentFixture('a', 'working'),
      agentFixture('b', 'working'),
      agentFixture('c', 'needs-you'),
      agentFixture('d', 'failed'),
    ]);
    expect(el('orchestrator-board-column-working').textContent).toContain('Working');
    expect(el('orchestrator-board-count-working').textContent).toBe('2');
    expect(el('orchestrator-board-count-needs-you').textContent).toBe('1');
    expect(el('orchestrator-board-count-failed').textContent).toBe('1');
    expect(el('orchestrator-board-count-done').textContent).toBe('0');
  });

  it('shows Nothing here in an empty column only', async () => {
    await renderBoard([agentFixture('a', 'working')]);
    expect(el('orchestrator-board-column-failed').textContent).toContain('Nothing here');
    expect(el('orchestrator-board-column-working').textContent).not.toContain('Nothing here');
  });

  it('calls onSelect with the card id', async () => {
    await renderBoard([agentFixture('a', 'working')]);
    await act(async () => el('orchestrator-board-card-a').click());
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('shows live activity for a working agent', async () => {
    await renderBoard([
      agentFixture('a', 'working', { activity: { kind: 'phase', phase: 'thinking' }, lastSnippet: 'old words' }),
    ]);
    const text = el('orchestrator-board-card-a').textContent ?? '';
    expect(text).toContain(activityLabel({ kind: 'phase', phase: 'thinking' }));
    expect(text).not.toContain('old words');
  });

  it('shows a cost only when the agent reported one', async () => {
    await renderBoard([agentFixture('a', 'done'), agentFixture('b', 'done', { credits: 7 })]);
    expect(el('orchestrator-board-card-a').textContent).not.toContain('-');
    expect(el('orchestrator-board-card-b').textContent).toContain('7 cr');
  });

  it('survives a reorder re-render in jsdom (FLIP is a no-op there)', async () => {
    await renderBoard([agentFixture('a', 'working'), agentFixture('b', 'working')]);
    await renderBoard([agentFixture('b', 'working'), agentFixture('a', 'done')]);
    expect(el('orchestrator-board-column-done').contains(el('orchestrator-board-card-a'))).toBe(true);
    expect(query('orchestrator-board')).not.toBeNull();
  });

  describe('FLIP', () => {
    const animate = vi.fn().mockReturnValue({ cancel: () => {} });
    let top = 0;
    const setReduced = (matches: boolean) => {
      vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }));
    };

    beforeEach(() => {
      top = 0;
      HTMLElement.prototype.animate = animate as unknown as HTMLElement['animate'];
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const moved = this.getAttribute('data-testid') === 'orchestrator-board-card-a' ? top : 0;
        return { left: 0, top: moved, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: moved } as DOMRect;
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    });

    it('animates a card that moved, but not on first mount', async () => {
      await renderBoard([agentFixture('a', 'working'), agentFixture('b', 'working')]);
      expect(animate).not.toHaveBeenCalled();
      top = 40;
      await renderBoard([agentFixture('b', 'working'), agentFixture('a', 'working')]);
      expect(animate).toHaveBeenCalledTimes(1);
    });

    it('measures nothing on a commit that leaves every column unchanged', async () => {
      await renderBoard([agentFixture('a', 'working', { lastSnippet: 'one' })]);
      const measure = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
      measure.mockClear();
      await renderBoard([agentFixture('a', 'working', { lastSnippet: 'two' })]);
      expect(measure).not.toHaveBeenCalled();
    });

    it('slides a card across columns by the visual delta, ignoring a scrolled source column', async () => {
      await renderBoard([agentFixture('a', 'working')]);
      top = 60;
      await act(async () => {
        el('orchestrator-board-column-working').dispatchEvent(new Event('scroll'));
      });
      expect(animate).not.toHaveBeenCalled();
      top = 20;
      await renderBoard([agentFixture('a', 'done')]);
      const keyframes = animate.mock.calls[0]?.[0] as Array<{ transform: string }>;
      expect(keyframes[0]?.transform).toBe('translate(0px, 40px)');
    });

    it('does not animate under reduced motion', async () => {
      setReduced(true);
      await renderBoard([agentFixture('a', 'working'), agentFixture('b', 'working')]);
      top = 40;
      await renderBoard([agentFixture('b', 'working'), agentFixture('a', 'working')]);
      expect(animate).not.toHaveBeenCalled();
    });
  });
});
