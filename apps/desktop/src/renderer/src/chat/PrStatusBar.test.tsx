import { renderToStaticMarkup } from 'react-dom/server';
import type { PrBarState, PrBinding, PrSnapshot } from '@shared/pullRequest';
import { describe, expect, it } from 'vitest';
import { PrStatusBar } from './PrStatusBar';
import { timeAgo } from './prBarModel';

/** Rendered to a string, like ApprovalChoice's tests and for the same reason: this package's vitest runs on `node`. */

const BINDING: PrBinding = {
  owner: 'example-org',
  repo: 'widgets',
  number: 611,
  url: 'https://github.com/example-org/widgets/pull/611',
  source: 'shell',
  boundAt: '',
  autoFix: true,
  autoMerge: true,
};

function snapshot(overrides: Partial<PrSnapshot> = {}): PrBarState['snapshot'] {
  return {
    owner: 'example-org',
    repo: 'widgets',
    number: 611,
    url: BINDING.url,
    title: 'feat: ladder',
    author: 'octo-dev',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feat/widget-ladder',
    headSha: 'sha-1',
    baseRefName: 'main',
    additions: 103,
    deletions: 16,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    autoMergeArmed: false,
    checks: [],
    repoSettings: { autoMergeAllowed: false, allowedMethods: ['squash'] },
    viewer: 'octo-dev',
    fetchedAt: 0,
    ...overrides,
  };
}

function markup(
  overrides: Partial<PrSnapshot> = {},
  refreshing = false,
  gh: PrBarState['gh'] = 'ok',
  autoMerge: PrBarState['autoMerge'] = { mode: 'desktop' },
  binding: PrBinding = BINDING
): string {
  const state: PrBarState = {
    sessionId: 'session-1',
    binding,
    snapshot: snapshot(overrides),
    gh,
    refreshing,
    autoMerge,
    autoFix: { status: 'watching', attempts: 0, max: 3 },
  };
  return renderToStaticMarkup(
    <PrStatusBar
      state={state}
      onDismiss={async () => ({ ok: true })}
      onRefresh={() => {}}
      onSetOption={async () => ({ ok: true })}
    />
  );
}

const has = (html: string, testId: string) => html.includes(`data-testid="${testId}"`);

describe('PrStatusBar', () => {
  it('draws a merged PR as finished, with nothing left to refresh or automate', () => {
    const html = markup({ state: 'MERGED', mergedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() });
    expect(has(html, 'pr-bar-refresh-btn')).toBe(false);
    expect(has(html, 'pr-bar-merged-icon')).toBe(true);
    expect(html).toContain('data-state="MERGED"');
    expect(html).toMatch(/data-testid="pr-bar-merged-at"[^>]*>merged 3h ago</);
    for (const testId of ['pr-bar-ci-btn', 'pr-bar-autofix-status', 'pr-bar-automerge-armed', 'pr-bar-closed-icon']) {
      expect(has(html, testId)).toBe(false);
    }
    for (const testId of ['pr-bar-open-btn', 'pr-bar-dismiss-btn', 'pr-bar-number-btn', 'pr-bar-diff']) {
      expect(has(html, testId)).toBe(true);
    }
  });

  it('keeps refresh on a merged bar while gh needs fixing, since the fix line says to refresh', () => {
    const html = markup({ state: 'MERGED' }, false, 'missing');
    expect(has(html, 'pr-bar-gh-fix')).toBe(true);
    expect(has(html, 'pr-bar-refresh-btn')).toBe(true);
  });

  it('leaves out the merged time when the read did not carry one', () => {
    expect(has(markup({ state: 'MERGED' }), 'pr-bar-merged-at')).toBe(false);
  });

  it('keeps a manual refresh for a closed PR, which can be reopened', () => {
    const html = markup({ state: 'CLOSED' });
    expect(has(html, 'pr-bar-refresh-btn')).toBe(true);
    expect(has(html, 'pr-bar-closed-icon')).toBe(true);
    expect(html).toContain('data-state="CLOSED"');
    for (const testId of ['pr-bar-merged-icon', 'pr-bar-merged-at', 'pr-bar-ci-btn', 'pr-bar-autofix-status']) {
      expect(has(html, testId)).toBe(false);
    }
  });

  it('leaves an open PR as it was', () => {
    const html = markup();
    for (const testId of ['pr-bar-refresh-btn', 'pr-bar-ci-btn', 'pr-bar-autofix-status', 'pr-bar-automerge-armed']) {
      expect(has(html, testId)).toBe(true);
    }
    expect(has(html, 'pr-bar-merged-icon')).toBe(false);
    expect(has(html, 'pr-bar-closed-icon')).toBe(false);
  });

  it('labels the open button for the built-in browser', () => {
    expect(markup()).toMatch(/aria-label="Open pull request in built-in browser"[^>]*data-testid="pr-bar-open-btn"/);
  });

  it('says a PR in the merge queue is queued to merge', () => {
    const html = markup({}, false, 'ok', { mode: 'desktop', queued: { position: 2 } });
    expect(html).toContain('data-testid="pr-bar-automerge-armed" data-queued="true"');
    expect(html).toContain('>Queued to merge</span>');
  });

  it('keeps a stopped auto-merge visible after the box unchecked itself', () => {
    const error = 'Auto-merge stopped: GitHub would not queue it: Pull request is not mergeable';
    const html = markup({}, false, 'ok', { mode: null, error }, { ...BINDING, autoMerge: false });
    expect(has(html, 'pr-bar-automerge-stopped')).toBe(true);
    expect(has(html, 'pr-bar-automerge-armed')).toBe(false);
  });

  it('spins the refresh button only while a read runs', () => {
    expect(markup({ state: 'CLOSED' }, true)).toContain('role="progressbar"');
    expect(markup({ state: 'CLOSED' }, false)).not.toContain('role="progressbar"');
  });
});

describe('timeAgo', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  it.each([
    ['2026-10-09T11:59:40Z', 'just now'],
    ['2026-10-09T11:55:00Z', '5m ago'],
    ['2026-10-09T09:00:00Z', '3h ago'],
    ['2026-10-02T12:00:00Z', '7d ago'],
  ])('%s reads %s', (iso, expected) => {
    expect(timeAgo(iso, now)).toBe(expected);
  });

  it('names the date once a month has passed, and gives up on a bad time', () => {
    expect(timeAgo('2026-01-02T12:00:00Z', now)).toMatch(/^on .*2026/);
    expect(timeAgo('not a time', now)).toBeNull();
  });
});
