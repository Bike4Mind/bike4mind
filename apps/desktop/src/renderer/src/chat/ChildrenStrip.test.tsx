// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChildrenStrip, MAX_VISIBLE_CHILDREN, childChipState, childChips } from './ChildrenStrip';

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

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

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
  onOpenSession: (id: string) => void = () => {}
): void {
  host ??= document.body.appendChild(document.createElement('div'));
  root ??= createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <ChildrenStrip sessions={sessions} statuses={statuses} parentId="parent" onOpenSession={onOpenSession} />
      </CssVarsProvider>
    );
  });
}

function all(id: string): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`) ?? []);
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
      summary({
        id: 'side',
        origin: { kind: 'side-chat', parentSessionId: 'parent' } as unknown as ChatSessionSummary['origin'],
      }),
      summary({
        id: 'grandchild',
        origin: { kind: 'spawned', parentSessionId: 'done-old' } as unknown as ChatSessionSummary['origin'],
      }),
      summary({ id: 'top-level', origin: undefined }),
    ];
    const chips = childChips(sessions, new Map([['waiting', 'needs-action']]), 'parent');
    expect(chips.map(chip => chip.id)).toEqual(['waiting', 'done-new', 'done-old']);
  });

  it('carries the branch only for a child in its own worktree', () => {
    const sessions = [
      summary({
        id: 'own',
        project: {
          workingDirectory: '/w',
          workspace: true,
          workspaceBranch: 'agent/own',
        } as ChatSessionSummary['project'],
      }),
      summary({
        id: 'shared',
        project: { workingDirectory: '/w', workspace: false, workspaceBranch: 'main' } as ChatSessionSummary['project'],
      }),
    ];
    const chips = childChips(sessions, new Map(), 'parent');
    expect(chips.find(chip => chip.id === 'own')?.branch).toBe('agent/own');
    expect(chips.find(chip => chip.id === 'shared')?.branch).toBeUndefined();
  });

  it('returns nothing without an open conversation', () => {
    expect(childChips([summary({ id: 'a' })], new Map(), null)).toEqual([]);
  });
});

describe('ChildrenStrip', () => {
  it('is not drawn when the conversation has no children', () => {
    render([summary({ id: 'other', origin: undefined })], new Map());
    expect(host?.querySelector('[data-testid="children-strip"]')).toBeNull();
  });

  it('draws one chip per child with its state, title and branch, and opens it on click', () => {
    const onOpen = vi.fn();
    render(
      [
        summary({ id: 'run', title: 'Running child' }),
        summary({
          id: 'fail',
          title: 'Failed child',
          lastOutcome: 'failed',
          project: {
            workingDirectory: '/w',
            workspace: true,
            workspaceBranch: 'agent/fail',
          } as ChatSessionSummary['project'],
        }),
      ],
      new Map([['run', 'processing']]),
      onOpen
    );
    const chips = all('children-strip-chip-btn');
    expect(chips.map(chip => chip.dataset.state)).toEqual(['processing', 'failed']);
    expect(all('children-strip-chip-title').map(title => title.textContent)).toEqual(['Running child', 'Failed child']);
    expect(all('children-strip-chip-branch').map(branch => branch.textContent)).toEqual(['agent/fail']);
    act(() => chips[1].click());
    expect(onOpen).toHaveBeenCalledWith('fail');
  });

  it(`collapses past ${MAX_VISIBLE_CHILDREN} children into +N, and expands on click`, () => {
    const sessions = Array.from({ length: MAX_VISIBLE_CHILDREN + 2 }, (_, index) =>
      summary({ id: `c${index}`, createdAt: `2026-01-0${index + 1}T00:00:00.000Z` })
    );
    render(sessions, new Map());
    expect(all('children-strip-chip-btn')).toHaveLength(MAX_VISIBLE_CHILDREN);
    const more = all('children-strip-more-btn')[0];
    expect(more.textContent).toBe('+2');
    act(() => more.click());
    expect(all('children-strip-chip-btn')).toHaveLength(MAX_VISIBLE_CHILDREN + 2);
    expect(more.getAttribute('aria-expanded')).toBe('true');
  });
});
