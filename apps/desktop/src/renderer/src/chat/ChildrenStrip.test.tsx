// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import {
  ChildrenStrip,
  chipHint,
  childChipState,
  childChips,
  foldsIntoParty,
  partyGroups,
  partySummary,
  stripLayout,
  type ChildChip,
} from './ChildrenStrip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

// Joy's popups (menus, selects, tooltips, modals) read every ancestor's computed style on each update,
// and jsdom resolves that against every emotion sheet with no layout to find; the inline style will do.
window.getComputedStyle = ((element: Element) => (element as HTMLElement).style) as typeof getComputedStyle;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

type Origin = ChatSessionSummary['origin'];
type Project = ChatSessionSummary['project'];

function summary(overrides: Partial<ChatSessionSummary> & { id: string }): ChatSessionSummary {
  return {
    title: overrides.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 2,
    origin: { kind: 'spawned', parentSessionId: 'parent' },
    ...overrides,
  } as ChatSessionSummary;
}

function render(
  sessions: ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>,
  options: { onOpenSession?: (id: string) => void; reportedIds?: ReadonlySet<string> } = {}
): void {
  host ??= document.body.appendChild(document.createElement('div'));
  root ??= createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <ChildrenStrip
          sessions={sessions}
          statuses={statuses}
          parentId="parent"
          reportedIds={options.reportedIds ?? new Set()}
          onOpenSession={options.onOpenSession ?? (() => {})}
        />
      </CssVarsProvider>
    );
  });
}

// Menus portal to document.body, so query the whole document rather than the host.
function all(id: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
}

function chip(overrides: Partial<ChildChip> & { id: string; state: ChildChip['state'] }): ChildChip {
  return { title: overrides.id, ...overrides };
}

describe('childChipState', () => {
  it('prefers the live status, then reads the outcome', () => {
    expect(childChipState('processing', 'failed')).toBe('processing');
    expect(childChipState('needs-action', undefined)).toBe('needs-action');
    expect(childChipState('done', 'finished')).toBe('finished');
    expect(childChipState(undefined, 'max-tokens')).toBe('finished');
    expect(childChipState(undefined, 'no-reply')).toBe('finished');
    for (const outcome of ['failed', 'aborted', 'turn-budget', 'context-limit'] as const) {
      expect(childChipState('done', outcome)).toBe('failed');
    }
  });
});

describe('childChips', () => {
  it('keeps direct, unarchived agent children only, most urgent first', () => {
    const sessions = [
      summary({ id: 'done-old', lastOutcome: 'finished', createdAt: '2026-01-01T00:00:00.000Z' }),
      summary({ id: 'done-new', lastOutcome: 'finished', createdAt: '2026-01-02T00:00:00.000Z' }),
      summary({ id: 'waiting' }),
      summary({ id: 'archived', archived: true }),
      summary({ id: 'side', origin: { kind: 'side-chat', parentSessionId: 'parent' } as unknown as Origin }),
      summary({ id: 'grandchild', origin: { kind: 'spawned', parentSessionId: 'done-old' } as unknown as Origin }),
      summary({ id: 'top-level', origin: undefined }),
    ];
    const chips = childChips(sessions, new Map([['waiting', 'needs-action']]), 'parent');
    expect(chips.map(entry => entry.id)).toEqual(['waiting', 'done-new', 'done-old']);
  });

  it('carries the branch only for a child in its own worktree', () => {
    const sessions = [
      summary({
        id: 'own',
        project: { workingDirectory: '/w', workspace: true, workspaceBranch: 'agent/own' } as Project,
      }),
      summary({
        id: 'shared',
        project: { workingDirectory: '/w', workspace: false, workspaceBranch: 'main' } as Project,
      }),
    ];
    const chips = childChips(sessions, new Map(), 'parent');
    expect(chips.find(entry => entry.id === 'own')?.branch).toBe('agent/own');
    expect(chips.find(entry => entry.id === 'shared')?.branch).toBeUndefined();
  });

  it('marks a finished child whose reply hit the length limit as cut short', () => {
    const chips = childChips([summary({ id: 'long', lastOutcome: 'max-tokens' })], new Map(), 'parent');
    expect(chips[0]).toMatchObject({ state: 'finished', cutShort: true });
  });

  it('returns nothing without an open conversation', () => {
    expect(childChips([summary({ id: 'a' })], new Map(), null)).toEqual([]);
  });
});

describe('chipHint', () => {
  it('appends a cut-short note to the snippet', () => {
    expect(chipHint({ snippet: 'Wrote it' })).toBe('Wrote it');
    expect(chipHint({ snippet: 'Wrote it', cutShort: true })).toBe('Wrote it (cut short)');
    expect(chipHint({ cutShort: true })).toBe('(cut short)');
    expect(chipHint({})).toBeUndefined();
  });

  it('leads with the full branch, which the chip itself truncates', () => {
    expect(chipHint({ branch: 'agent/a-very-long-branch-name' })).toBe('Branch: agent/a-very-long-branch-name');
    expect(chipHint({ branch: 'agent/x', snippet: 'Wrote it', cutShort: true })).toBe(
      'Branch: agent/x\nWrote it (cut short)'
    );
  });
});

describe('stripLayout', () => {
  it('gives live and failed children chips and folds finished ones away', () => {
    const layout = stripLayout(
      [
        chip({ id: 'w', state: 'needs-action' }),
        chip({ id: 'f', state: 'failed' }),
        chip({ id: 'd', state: 'finished' }),
      ],
      new Set()
    );
    expect(layout.active.map(entry => entry.id)).toEqual(['w', 'f']);
    expect(layout.done.map(entry => entry.id)).toEqual(['d']);
    expect(layout.hidden).toBe(false);
  });

  it('hides once nothing is live and every child has reported into the thread', () => {
    const settled = [chip({ id: 'f', state: 'failed' }), chip({ id: 'd', state: 'finished' })];
    expect(stripLayout(settled, new Set(['f', 'd'])).hidden).toBe(true);
    expect(stripLayout(settled, new Set(['d'])).hidden).toBe(false);
    expect(stripLayout([chip({ id: 'r', state: 'processing' })], new Set(['r'])).hidden).toBe(false);
    expect(stripLayout([], new Set()).hidden).toBe(true);
  });
});

describe('ChildrenStrip', () => {
  it('is not drawn when the conversation has no children', () => {
    render([summary({ id: 'other', origin: undefined })], new Map());
    expect(all('children-strip')).toHaveLength(0);
  });

  it('is not drawn once every child has settled and reported', () => {
    render([summary({ id: 'a', lastOutcome: 'finished' })], new Map(), { reportedIds: new Set(['a']) });
    expect(all('children-strip')).toHaveLength(0);
  });

  it('draws a chip per active child with its state, title and branch, and opens it on click', () => {
    const onOpenSession = vi.fn();
    render(
      [
        summary({ id: 'run', title: 'Running child' }),
        summary({
          id: 'fail',
          title: 'Failed child',
          lastOutcome: 'failed',
          project: { workingDirectory: '/w', workspace: true, workspaceBranch: 'agent/fail' } as Project,
        }),
      ],
      new Map([['run', 'processing']]),
      { onOpenSession }
    );
    const chips = all('children-strip-chip-btn');
    expect(chips.map(entry => entry.dataset.state)).toEqual(['processing', 'failed']);
    expect(all('children-strip-chip-title').map(title => title.textContent)).toEqual(['Running child', 'Failed child']);
    expect(all('children-strip-chip-branch').map(branch => branch.textContent)).toEqual(['agent/fail']);
    expect(all('children-strip-done-btn')).toHaveLength(0);
    act(() => chips[1].click());
    expect(onOpenSession).toHaveBeenCalledWith('fail');
  });

  it('folds finished children into one "N done" menu that opens each', () => {
    const onOpenSession = vi.fn();
    render(
      [
        summary({ id: 'run' }),
        summary({ id: 'd1', title: 'First done', lastOutcome: 'finished', createdAt: '2026-01-02T00:00:00.000Z' }),
        summary({ id: 'd2', title: 'Second done', lastOutcome: 'max-tokens' }),
      ],
      new Map([['run', 'processing']]),
      { onOpenSession }
    );
    expect(all('children-strip-chip-btn')).toHaveLength(1);
    const done = all('children-strip-done-btn')[0];
    expect(done.textContent).toContain('2 done');
    act(() => done.click());
    const items = all('children-strip-done-item');
    expect(items.map(item => item.textContent)).toEqual(['First done', 'Second done']);
    expect(items[1].getAttribute('title')).toBe('(cut short)');
    act(() => items[1].click());
    expect(onOpenSession).toHaveBeenCalledWith('d2');
  });

  it('keeps the chips at the threshold, counting the done menu as one', () => {
    render(
      [summary({ id: 'a' }), summary({ id: 'b' }), summary({ id: 'c' }), summary({ id: 'd', lastOutcome: 'finished' })],
      new Map([
        ['a', 'processing'],
        ['b', 'processing'],
        ['c', 'needs-action'],
      ])
    );
    expect(all('children-strip-chip-btn')).toHaveLength(3);
    expect(all('children-strip-done-btn')).toHaveLength(1);
    expect(all('children-strip-party-btn')).toHaveLength(0);
  });

  it('folds into one Party pill past the threshold, whose roster groups and opens each session', () => {
    const onOpenSession = vi.fn();
    render(
      [
        summary({ id: 'w1', title: 'Worker one' }),
        summary({ id: 'w2', title: 'Worker two' }),
        summary({ id: 'n1', title: 'Asker' }),
        summary({ id: 'f1', title: 'Broke', lastOutcome: 'failed' }),
        summary({ id: 'd1', title: 'Shipped', lastOutcome: 'finished' }),
      ],
      new Map([
        ['w1', 'processing'],
        ['w2', 'processing'],
        ['n1', 'needs-action'],
      ]),
      { onOpenSession }
    );
    expect(all('children-strip-chip-btn')).toHaveLength(0);
    expect(all('children-strip-done-btn')).toHaveLength(0);
    const pill = all('children-strip-party-btn')[0];
    expect(all('children-strip-party-summary')[0].textContent).toBe('Party: 5 - 1 needs you');
    act(() => pill.click());
    expect(all('children-strip-party-group').map(group => group.getAttribute('data-group'))).toEqual([
      'needs-you',
      'working',
      'done',
    ]);
    const items = all('children-strip-party-item');
    expect(items.map(item => item.getAttribute('data-state'))).toEqual([
      'needs-action',
      'processing',
      'processing',
      'failed',
      'finished',
    ]);
    act(() => items[0].click());
    expect(onOpenSession).toHaveBeenCalledWith('n1');
  });
});

describe('foldsIntoParty', () => {
  it('folds only when more than four buttons would be drawn', () => {
    const live = (n: number) => Array.from({ length: n }, (_, i) => chip({ id: `l${i}`, state: 'processing' }));
    const done = [chip({ id: 'd', state: 'finished' })];
    expect(foldsIntoParty(live(4), [])).toBe(false);
    expect(foldsIntoParty(live(3), done)).toBe(false);
    expect(foldsIntoParty(live(5), [])).toBe(true);
    expect(foldsIntoParty(live(4), done)).toBe(true);
  });
});

describe('partyGroups', () => {
  it('orders needs you, working, done, drops empty groups and files failed under done', () => {
    const groups = partyGroups([
      chip({ id: 'f', state: 'failed' }),
      chip({ id: 'n', state: 'needs-action' }),
      chip({ id: 'd', state: 'finished' }),
    ]);
    expect(groups.map(group => [group.key, group.chips.map(c => c.id)])).toEqual([
      ['needs-you', ['n']],
      ['done', ['f', 'd']],
    ]);
  });
});

describe('partySummary', () => {
  it('leads with who needs the user, then who is working, then who did not finish, else all done', () => {
    const n = (state: ChildChip['state'], count: number) =>
      Array.from({ length: count }, (_, i) => chip({ id: `${state}${i}`, state }));
    expect(partySummary([...n('needs-action', 3), ...n('processing', 9)])).toBe('Party: 12 - 3 need you');
    expect(partySummary([...n('processing', 4), ...n('finished', 2)])).toBe('Party: 6 - 4 working');
    expect(partySummary([...n('finished', 5), ...n('failed', 1)])).toBe('Party: 6 - 1 did not finish');
    expect(partySummary(n('finished', 5))).toBe('Party: 5 - all done');
  });
});
