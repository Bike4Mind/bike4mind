// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PrBarState } from '@shared/pullRequest';
import { AgentPrDialog } from './AgentPrDialog';
import { OrchestratorStage } from './OrchestratorStage';
import { singlePaneLayout } from './orchestratorLayout';
import { createThemedMount, el, query, agentFixture } from './testUtils';

const REF = {
  owner: 'example-org',
  repo: 'widgets',
  number: 611,
  url: 'https://github.com/example-org/widgets/pull/611',
};
const snapshot = (
  overrides: Partial<NonNullable<PrBarState['snapshot']>> = {}
): NonNullable<PrBarState['snapshot']> => ({
  ...REF,
  title: 'feat: ladder',
  author: 'octo-dev',
  state: 'OPEN',
  isDraft: false,
  headRefName: 'feat/widget-ladder',
  headSha: 'sha-1',
  baseRefName: 'main',
  baseSha: 'base-1',
  additions: 157,
  deletions: 0,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  reviewDecision: 'REVIEW_REQUIRED',
  autoMergeArmed: false,
  checks: [{ name: 'Build', bucket: 'pass', required: true, url: `${REF.url}/checks` }],
  repoSettings: { autoMergeAllowed: false, allowedMethods: ['squash'] },
  viewer: 'octo-dev',
  fetchedAt: 0,
  ...overrides,
});

const themed = createThemedMount();
const state = (sessionId = 'agent'): PrBarState => ({
  sessionId,
  binding: { ...REF, source: 'shell', boundAt: '' },
  snapshot: snapshot({ mergeable: 'CONFLICTING' }),
  gh: 'ok',
  refreshing: false,
  autoFix: { status: 'off', attempts: 0, max: 5 },
  autoMerge: { mode: null },
});
const listeners = new Set<(next: PrBarState) => void>();
const api = {
  getState: vi.fn(),
  watch: vi.fn(),
  refresh: vi.fn(),
  dismiss: vi.fn(),
  setOption: vi.fn(),
  onStateChanged: vi.fn((listener: (next: PrBarState) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }),
};
const onClose = vi.fn();
const onOpenLink = vi.fn();
const show = (sessionId = 'agent') =>
  themed.render(
    <AgentPrDialog key={sessionId} sessionId={sessionId} title="Worker" onClose={onClose} onOpenLink={onOpenLink} />
  );
const click = async (id: string) => {
  await act(async () => el(id).click());
};
/** A plain click on the badge opens GitHub; Shift opens these in-app details. */
const shiftClick = async (id: string) => {
  await act(async () => {
    el(id).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
  });
};
const push = async (next: PrBarState) => {
  await act(async () => listeners.forEach(listener => listener(next)));
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getState.mockImplementation(async (id: string) => state(id));
  api.refresh.mockResolvedValue(undefined);
  api.dismiss.mockResolvedValue({ ok: true });
  api.setOption.mockResolvedValue({ ok: true });
  (window as unknown as { b4m: unknown }).b4m = { pullRequests: api, shell: { openExternal: vi.fn() } };
});
afterEach(() => {
  themed.unmount();
  listeners.clear();
  vi.useRealTimers();
});

it('uses the existing PR bar, CI details and all automation callbacks for the selected session', async () => {
  await show();
  expect(el('pr-bar-branch').textContent).toBe('feat/widget-ladder');
  expect(query('pr-bar-diff')).not.toBeNull();
  expect(query('pr-bar-conflicts')).not.toBeNull();
  await click('pr-bar-refresh-btn');
  expect(api.refresh).toHaveBeenCalledWith('agent');
  await click('pr-bar-open-btn');
  expect(onOpenLink).toHaveBeenCalledWith(REF.url);
  await click('pr-bar-ci-btn');
  expect(el('pr-ci-review').textContent).toContain('Review:');
  expect(el('pr-ci-merge').textContent).toBeTruthy();
  await click('pr-ci-checks-toggle');
  expect(el('pr-ci-check-pass').textContent).toContain('Build');
  for (const [name, option] of [
    ['autofix', 'autoFix'],
    ['automerge', 'autoMerge'],
    ['autoarchive', 'autoArchive'],
  ]) {
    await click(`pr-ci-${name}-checkbox`);
    expect(api.setOption).toHaveBeenLastCalledWith('agent', option, true);
  }
  await click('pr-bar-dismiss-btn');
  expect(api.dismiss).toHaveBeenCalledWith('agent');
  expect(onClose).toHaveBeenCalled();
  expect(api.watch).not.toHaveBeenCalled();
});

it('filters pushes, ignores late reads, polls only while open, and leaves the root watch alone', async () => {
  vi.useFakeTimers();
  let resolve!: (value: PrBarState | null) => void;
  api.getState.mockImplementationOnce(
    () =>
      new Promise<PrBarState | null>(done => {
        resolve = done;
      })
  );
  await show();
  expect(document.body.textContent).toContain('Reading pull request...');
  await push(state('root'));
  expect(query('pr-bar')).toBeNull();
  await push({ ...state(), snapshot: snapshot({ headRefName: 'new-branch' }) });
  await act(async () => resolve(state()));
  expect(el('pr-bar-branch').textContent).toBe('new-branch');
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(api.getState).toHaveBeenCalledTimes(2);
  themed.unmount();
  expect(listeners.size).toBe(0);
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(api.getState).toHaveBeenCalledTimes(2);
  expect(api.watch).not.toHaveBeenCalled();
});

it('keeps the PR bar and shows a refresh failure inline, then clears it on retry', async () => {
  await show();
  const bar = el('pr-bar');
  api.refresh.mockRejectedValueOnce(new Error('Refresh failed'));
  await click('pr-bar-refresh-btn');
  expect(el('pr-bar')).toBe(bar);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Refresh failed');
  expect(query('orchestrator-pr-retry')).toBeNull();
  await click('pr-bar-refresh-btn');
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(el('pr-bar')).toBe(bar);
});

it('handles read failures, retry, unbinding and session switches', async () => {
  api.getState.mockRejectedValueOnce(new Error('Read failed'));
  await show();
  expect(document.body.textContent).toContain('Read failed');
  await click('orchestrator-pr-retry');
  expect(query('pr-bar')).not.toBeNull();
  await push({ ...state(), binding: null });
  expect(document.body.textContent).toContain('No pull request is linked');
  await show('other');
  expect(api.getState).toHaveBeenLastCalledWith('other');
  await push({ ...state(), snapshot: snapshot({ headRefName: 'wrong-agent' }) });
  expect(el('pr-bar-branch').textContent).not.toBe('wrong-agent');
});

it('mounts on demand at the stage, restores focus on close and hides immediately in presenter mode', async () => {
  const agent = agentFixture('agent', 'done', { pr: { number: 611, state: 'open' } });
  const render = (presenting = false) =>
    themed.render(
      <OrchestratorStage
        agents={[agent]}
        rootId="root"
        layout={singlePaneLayout('table')}
        onLayoutChange={vi.fn()}
        actions={{ open: vi.fn(), stop: vi.fn(), archive: vi.fn() }}
        introPlaying={false}
        presenter={{ on: presenting, onToggle: vi.fn() }}
      />
    );
  await render();
  expect(api.getState).not.toHaveBeenCalled();
  const badge = el('orchestrator-pr-indicator');
  act(() => badge.focus());
  await shiftClick('orchestrator-pr-indicator');
  expect(api.getState).toHaveBeenCalledWith('agent');
  expect(query('orchestrator-peek-drawer-region')).toBeNull();
  await click('orchestrator-pr-close');
  expect(query('orchestrator-pr-dialog')).toBeNull();
  expect(document.activeElement).toBe(badge);
  await shiftClick('orchestrator-pr-indicator');
  await act(async () =>
    el('orchestrator-pr-close').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
  );
  expect(query('orchestrator-pr-dialog')).toBeNull();
  expect(document.activeElement).toBe(badge);
  await shiftClick('orchestrator-pr-indicator');
  await render(true);
  expect(query('orchestrator-pr-dialog')).toBeNull();
  expect(listeners.size).toBe(0);
  expect(document.body.textContent).not.toContain('611');
});
