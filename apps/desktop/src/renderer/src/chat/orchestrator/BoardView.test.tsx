// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityLabel } from './activity';
import { SIDEBAR_DEFAULT_WIDTH } from '../sidebarWidth';
import { assignPersonas } from './tavern/agentPersona';
import { BoardView, COLUMN_GAP, COLUMN_MIN_WIDTH, EMPTY_COLUMN_WIDTH, packBoardRows } from './BoardView';
import type { AgentView } from './roster';
import { agentFixture, createThemedMount, el, query } from './testUtils';

const onSelect = vi.fn();
const themed = createThemedMount();

const renderBoard = (agents: AgentView[]) =>
  themed.render(
    <BoardView
      agents={agents}
      onSelect={onSelect}
      selectedId={null}
      introPlaying={false}
      personas={assignPersonas(agents)}
    />
  );

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
});

describe('BoardView', () => {
  it('names the spawning agent on a card below the first level only', async () => {
    await renderBoard([
      agentFixture('lead', 'working', { title: 'Lead the audit' }),
      agentFixture('helper', 'working', { depth: 2, parentId: 'lead' }),
    ]);
    expect(el('orchestrator-board-via-helper').textContent).toBe('via Lead the audit');
    expect(query('orchestrator-board-via-lead')).toBeNull();
  });

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

  it('folds an empty column to its header and lets columns with cards take the width', async () => {
    await renderBoard([agentFixture('a', 'working')]);
    const failed = el('orchestrator-board-column-failed');
    const working = el('orchestrator-board-column-working');
    expect(failed.dataset.empty).toBe('true');
    expect(failed.textContent).toBe('Failed0');
    expect(getComputedStyle(failed).minWidth).toBe('0px');
    expect(working.dataset.empty).toBeUndefined();
    expect(getComputedStyle(working).minWidth).toBe('150px');
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
    expect(el('orchestrator-board-card-b').textContent).toContain('7 credits');
  });

  it('survives a reorder re-render in jsdom (FLIP is a no-op there)', async () => {
    await renderBoard([agentFixture('a', 'working'), agentFixture('b', 'working')]);
    await renderBoard([agentFixture('b', 'working'), agentFixture('a', 'done')]);
    expect(el('orchestrator-board-column-done').contains(el('orchestrator-board-card-a'))).toBe(true);
    expect(query('orchestrator-board')).not.toBeNull();
  });

  it('keeps all four columns on one row beside the docked conversation in a 1440px window', () => {
    // The window less the default sidebar, ChatShell's 380px dock and its 1px border, less the board's padding.
    const available = 1440 - SIDEBAR_DEFAULT_WIDTH - 380 - 1 - 2 * 12;
    const full = ['needs-you', 'working', 'done', 'failed'].map(id => ({ id, empty: false }));
    expect(packBoardRows(full, available)).toHaveLength(1);
  });

  describe('packBoardRows', () => {
    const columns = (...empties: boolean[]) => empties.map((empty, index) => ({ id: String(index), empty }));
    const ids = (rows: { id: string }[][]) => rows.map(row => row.map(column => column.id));
    const oneRowOfFour = 4 * COLUMN_MIN_WIDTH + 3 * COLUMN_GAP;

    it('keeps one row until it is measured, and while everything fits', () => {
      expect(ids(packBoardRows(columns(false, false, false, false), null))).toEqual([['0', '1', '2', '3']]);
      expect(ids(packBoardRows(columns(false, false, false, false), oneRowOfFour))).toEqual([['0', '1', '2', '3']]);
    });

    it('wraps into two balanced rows rather than three and one', () => {
      expect(ids(packBoardRows(columns(false, false, false, false), oneRowOfFour - 1))).toEqual([
        ['0', '1'],
        ['2', '3'],
      ]);
    });

    it('counts an empty column at its folded width, so a sparse board stays on one row', () => {
      const sparse = 2 * COLUMN_MIN_WIDTH + 2 * EMPTY_COLUMN_WIDTH + 3 * COLUMN_GAP;
      expect(packBoardRows(columns(false, true, false, true), sparse)).toHaveLength(1);
      expect(packBoardRows(columns(false, false, false, false), sparse)).toHaveLength(2);
    });

    it('falls back to one column per row when not even two fit', () => {
      expect(ids(packBoardRows(columns(false, false, false, false), COLUMN_MIN_WIDTH))).toEqual([
        ['0'],
        ['1'],
        ['2'],
        ['3'],
      ]);
    });
  });

  it('lays the columns out in rows, in board order', async () => {
    await renderBoard([agentFixture('a', 'needs-you'), agentFixture('b', 'failed')]);
    const rows = document.querySelectorAll('[data-testid="orchestrator-board-row"]');
    expect(rows).toHaveLength(1);
    expect(Array.from(rows[0]?.children ?? []).map(column => column.getAttribute('data-testid'))).toEqual([
      'orchestrator-board-column-needs-you',
      'orchestrator-board-column-working',
      'orchestrator-board-column-done',
      'orchestrator-board-column-failed',
    ]);
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
      vi.unstubAllGlobals();
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

    it('re-snapshots when the board resizes, so a resize alone never reads as a move', async () => {
      let resized: (() => void) | null = null;
      const observe = vi.fn();
      const disconnect = vi.fn();
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(callback: () => void) {
            resized = callback;
          }
          observe = observe;
          unobserve() {}
          disconnect = disconnect;
        }
      );
      await renderBoard([agentFixture('a', 'working')]);
      expect(observe).toHaveBeenCalledWith(el('orchestrator-board'));

      top = 60;
      await act(async () => resized?.());
      expect(animate).not.toHaveBeenCalled();
      top = 20;
      await renderBoard([agentFixture('a', 'done')]);
      const keyframes = animate.mock.calls[0]?.[0] as Array<{ transform: string }>;
      expect(keyframes[0]?.transform).toBe('translate(0px, 40px)');

      themed.unmount();
      expect(disconnect).toHaveBeenCalled();
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
