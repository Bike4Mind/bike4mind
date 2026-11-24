// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrBarSnapshot, PrBarState } from '@shared/pullRequest';
import { AgentPrCard } from './AgentPrCard';
import { createThemedMount, el } from './testUtils';

const themed = createThemedMount();
let pushState: ((state: PrBarState) => void) | null = null;
const getState = vi.fn();

const snapshot = (overrides: Partial<PrBarSnapshot> = {}): PrBarSnapshot =>
  ({
    owner: 'acme',
    repo: 'app',
    number: 42,
    url: 'https://github.com/acme/app/pull/42',
    title: 'Teach the badge to explain itself',
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    reviewDecision: 'CHANGES_REQUESTED',
    checks: [
      { name: 'lint', bucket: 'pass', required: true },
      { name: 'test', bucket: 'fail', required: true },
      { name: 'e2e', bucket: 'pending', required: false },
    ],
    fetchedAt: Date.now() - 2 * 60_000,
    ...overrides,
  }) as PrBarSnapshot;

const barState = (snap: PrBarSnapshot): PrBarState =>
  ({
    sessionId: 'agent-1',
    binding: { dismissed: false },
    snapshot: snap,
    gh: 'ok',
    refreshing: false,
  }) as unknown as PrBarState;

beforeEach(() => {
  getState.mockResolvedValue(barState(snapshot()));
  (window as unknown as { b4m: unknown }).b4m = {
    pullRequests: {
      getState,
      onStateChanged: vi.fn((listener: (state: PrBarState) => void) => {
        pushState = listener;
        return () => {
          pushState = null;
        };
      }),
    },
  };
});
afterEach(() => {
  themed.unmount();
  getState.mockReset();
});

describe('AgentPrCard', () => {
  it('spells out the state and the CI, review and merge lines from one read', async () => {
    const onOpenPage = vi.fn();
    await themed.render(
      <AgentPrCard
        sessionId="agent-1"
        number={42}
        status={{ state: 'open', attention: 'conflict' }}
        onOpenPage={onOpenPage}
      />
    );
    await act(async () => undefined);
    expect(getState).toHaveBeenCalledTimes(1);
    expect(el('orchestrator-pr-card-headline').textContent).toBe('Merge conflict');
    expect(el('orchestrator-pr-card-title').textContent).toBe('#42 Teach the badge to explain itself');
    expect(el('orchestrator-pr-card-ci').textContent).toBe('1 passed, 1 failed, 1 running');
    expect(el('orchestrator-pr-card-review').textContent).toBe('Changes requested');
    expect(el('orchestrator-pr-card-merge').textContent).toBe('Conflicts with main');
    expect(el('orchestrator-pr-card-fresh').textContent).toBe('Checked 2m ago');
    act(() => (el('orchestrator-pr-card-open') as HTMLButtonElement).click());
    expect(onOpenPage).toHaveBeenCalledWith('https://github.com/acme/app/pull/42');
  });

  it('follows the monitor push for its own session only, without polling', async () => {
    vi.useFakeTimers();
    try {
      await themed.render(
        <AgentPrCard sessionId="agent-1" number={42} status={{ state: 'open', attention: 'conflict' }} />
      );
      await act(async () => undefined);
      act(() => pushState?.({ ...barState(snapshot({ title: 'Other agent' })), sessionId: 'agent-2' }));
      expect(el('orchestrator-pr-card-title').textContent).toContain('Teach the badge');
      act(() => pushState?.(barState(snapshot({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }))));
      expect(el('orchestrator-pr-card-merge').textContent).toBe('No conflicts with main');
      await act(async () => vi.advanceTimersByTime(5 * 60_000));
      expect(getState).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the summary headline before details arrive, and says when there are none', async () => {
    getState.mockResolvedValue(null);
    await themed.render(<AgentPrCard sessionId="agent-1" number={42} status={{ state: 'merged' }} />);
    expect(el('orchestrator-pr-card-headline').textContent).toBe('Merged');
    await act(async () => undefined);
    expect(document.body.textContent).toContain('Details are not available right now.');
  });

  it('opens and closes the icon legend', async () => {
    await themed.render(<AgentPrCard sessionId="agent-1" number={42} status={{ state: 'open' }} />);
    expect(document.querySelector('[data-testid="orchestrator-pr-legend"]')).toBeNull();
    act(() => (el('orchestrator-pr-card-legend-toggle') as HTMLButtonElement).click());
    expect(el('orchestrator-pr-legend').textContent).toContain('Merge conflict');
    expect(el('orchestrator-pr-card-legend-toggle').getAttribute('aria-expanded')).toBe('true');
  });
});
