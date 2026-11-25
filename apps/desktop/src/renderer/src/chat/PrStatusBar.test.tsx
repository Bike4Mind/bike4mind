import { renderToStaticMarkup } from 'react-dom/server';
import type { PrBarState, PrBinding, PrSnapshot, PrBarSnapshot, PrSummary } from '@shared/pullRequest';
import { describe, expect, it, vi } from 'vitest';
import { PrStatusBar } from './PrStatusBar';
import { timeAgo } from './prBarModel';
import type { PrAttention } from '@shared/prAttention';
import {
  CHANGES_REQUESTED_COLOR,
  MERGED_COLOR,
  READY_COLOR,
  prIconColor,
  prIconLabel,
  prStateColor,
} from './prStateStyle';
import { STATES, renderBar, renderSidebar } from './prRenderSupport';
import { isBrowsableUrl, openInSessionBrowser, openInSystemBrowser, routePrLink, type PrLinkTargets } from './prLinks';
import { applyPrSummaryEvents } from './prSummaries';

describe('PrStatusBar', () => {
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
      baseSha: 'base-1',
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
    binding: PrBinding = BINDING,
    autoFix: PrBarState['autoFix'] = { status: 'watching', attempts: 0, max: 5 }
  ): string {
    const state: PrBarState = {
      sessionId: 'session-1',
      binding,
      snapshot: snapshot(overrides),
      gh,
      refreshing,
      autoMerge,
      autoFix,
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

    it('says the conflicts are being fixed only while an auto-fix turn for them runs', () => {
      const conflicting = { mergeable: 'CONFLICTING' } as const;
      const chip = (html: string) =>
        html
          .slice(html.indexOf('data-testid="pr-bar-conflicts"'))
          .replace(/<[^>]*>/g, ' ')
          .match(/(Fixing conflicts\.\.\.|Conflicts)/)?.[1];
      expect(chip(markup(conflicting))).toBe('Conflicts');
      const fixing = { status: 'started', attempts: 1, max: 5, conflicts: true } as const;
      expect(chip(markup(conflicting, false, 'ok', { mode: 'desktop' }, BINDING, fixing))).toBe('Fixing conflicts...');
      const other = { status: 'started', attempts: 1, max: 5 } as const;
      expect(chip(markup(conflicting, false, 'ok', { mode: 'desktop' }, BINDING, other))).toBe('Conflicts');
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
});

describe('prStateStyle', () => {
  const iconColor = (html: string) => /data-pr-state="[a-z]+" data-pr-color="([^"]+)"/.exec(html)?.[1];
  const glyphs = (html: string) => [...html.matchAll(/data-pr-glyph="([a-zA-Z]+)"/g)].map(match => match[1]);

  /** One read per attention, with the glyph and colour the icon must draw for it. */
  const ATTENTION_CASES: {
    attention: PrAttention;
    read: Partial<PrBarSnapshot>;
    glyph: string | null;
    color: (mode: 'light' | 'dark') => string;
  }[] = [
    { attention: 'conflict', read: { mergeable: 'CONFLICTING' }, glyph: 'conflict', color: () => 'danger.plainColor' },
    {
      attention: 'ciFailed',
      read: { checks: [{ name: 'lint', bucket: 'fail', required: true }] },
      glyph: 'ciFailed',
      color: () => 'danger.plainColor',
    },
    {
      attention: 'changesRequested',
      read: { reviewDecision: 'CHANGES_REQUESTED' },
      glyph: 'changesRequested',
      color: mode => CHANGES_REQUESTED_COLOR[mode],
    },
    {
      attention: 'ciRunning',
      read: { checks: [{ name: 'test', bucket: 'pending', required: true }] },
      glyph: 'ciRunning',
      color: () => 'warning.plainColor',
    },
    {
      attention: 'awaitingReview',
      read: { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' },
      glyph: null,
      color: () => 'text.secondary',
    },
    {
      attention: 'approvedBlocked',
      read: { reviewDecision: 'APPROVED', mergeStateStatus: 'BLOCKED' },
      glyph: 'approvedBlocked',
      color: () => 'success.plainColor',
    },
    { attention: 'ready', read: {}, glyph: 'ready', color: mode => READY_COLOR[mode] },
  ];

  describe('PR state colour', () => {
    it.each(['light', 'dark'] as const)('is the same in the bar and the sidebar for every state (%s)', mode => {
      for (const { display, state, isDraft, queued } of STATES) {
        const bar = renderBar(mode, state, isDraft, queued);
        // The fixture read is approved-or-not-required, green and clean: an open PR is ready.
        const attention = display === 'open' ? 'ready' : undefined;
        const sidebar = renderSidebar(
          { number: 611, state: display, ...(attention ? { attention } : {}) },
          'done',
          mode
        );
        expect(bar).toContain(`data-testid="pr-bar-${display}-icon" data-pr-state="${display}"`);
        expect(sidebar).toContain(`data-session-pr-state="${display}"`);
        expect(iconColor(bar)).toBe(prIconColor({ state: display, attention }, mode));
        expect(iconColor(sidebar)).toBe(iconColor(bar));
      }
    });

    it.each(['light', 'dark'] as const)('draws each attention with its glyph and colour, in both places (%s)', mode => {
      for (const { attention, read, glyph, color } of ATTENTION_CASES) {
        const bar = renderBar(mode, 'OPEN', false, false, read);
        const sidebar = renderSidebar({ number: 611, state: 'open', attention }, 'done', mode);
        for (const html of [bar, sidebar]) {
          expect(html).toContain(`data-pr-attention="${attention}"`);
          expect(iconColor(html)).toBe(color(mode));
          expect(glyphs(html)).toEqual(glyph ? [glyph] : []);
        }
      }
    });

    it('keeps draft, queued, merged and closed on their own icons with no attention mark', () => {
      for (const state of ['draft', 'queued', 'merged', 'closed'] as const) {
        const html = renderSidebar({ number: 611, state, attention: 'ciFailed', behind: true, autoMerge: true });
        expect(html).not.toContain('data-pr-attention');
        expect(glyphs(html)).toEqual([]);
        expect(iconColor(html)).toBe(prStateColor(state, 'light'));
      }
    });

    it('adds behind and auto-merge badges, and fades a last-known icon', () => {
      const html = renderSidebar({
        number: 9,
        state: 'open',
        attention: 'ready',
        behind: true,
        autoMerge: true,
        stale: true,
      });
      expect(glyphs(html)).toEqual(['ready', 'behind', 'autoMerge']);
      expect(html).toContain('data-pr-behind="true"');
      expect(html).toContain('data-pr-auto-merge="true"');
      expect(html).toContain('data-pr-stale="true"');
    });

    it('names the state in words for hover and screen readers', () => {
      expect(prIconLabel(123, { state: 'open', attention: 'changesRequested', behind: true })).toBe(
        'PR #123 - Open: changes requested, behind base'
      );
      expect(prIconLabel(5, { state: 'open', attention: 'ready', autoMerge: true, stale: true })).toBe(
        'PR #5 - Open: ready to merge, auto-merge on, last known'
      );
      expect(prIconLabel(7, { state: 'merged' })).toBe('PR #7 - Merged');
      const html = renderSidebar({ number: 42, state: 'open', attention: 'ciFailed' });
      expect(html).toContain('title="PR #42 - Open: CI failed"');
    });

    it('follows GitHub: open green, draft grey, queued amber, merged purple, closed red', () => {
      expect(prStateColor('open', 'light')).toBe('success.plainColor');
      expect(prStateColor('draft', 'light')).toBe('text.tertiary');
      expect(prStateColor('queued', 'light')).toBe('warning.plainColor');
      expect(prStateColor('queued', 'dark')).toBe('warning.plainColor');
      expect(prStateColor('merged', 'light')).toBe(MERGED_COLOR.light);
      expect(prStateColor('merged', 'dark')).toBe(MERGED_COLOR.dark);
      expect(prStateColor('closed', 'dark')).toBe('danger.plainColor');
    });

    it('colours a queued PR in the bar and its Queued to merge chip as warnings', () => {
      const html = renderBar('light', 'OPEN', false, true);
      expect(html).toContain('data-testid="pr-bar-queued-icon" data-pr-state="queued"');
      const chip = /<[^>]*data-testid="pr-bar-automerge-armed"[^>]*>/.exec(html)?.[0];
      expect(chip).toContain('data-queued="true"');
      expect(chip).toContain('MuiChip-colorWarning');
    });
  });
});

describe('prLinks', () => {
  const PR = 'https://github.com/example-org/widgets/pull/611';
  const PLAIN = { metaKey: false, ctrlKey: false };

  function fakeTargets(navigate: PrLinkTargets['navigate'] = async () => undefined) {
    return { openExternal: vi.fn(async () => undefined), navigate: vi.fn(navigate) };
  }

  describe('routePrLink', () => {
    it('sends a plain click to the built-in browser', () => {
      const targets = fakeTargets();
      const openBuiltIn = vi.fn();
      routePrLink(PR, PLAIN, openBuiltIn, targets);
      expect(openBuiltIn).toHaveBeenCalledWith(PR);
      expect(targets.openExternal).not.toHaveBeenCalled();
    });

    it.each([
      ['Cmd', { metaKey: true, ctrlKey: false }],
      ['Ctrl', { metaKey: false, ctrlKey: true }],
    ])('sends a %s-click to the system browser', (_label, click) => {
      const targets = fakeTargets();
      const openBuiltIn = vi.fn();
      routePrLink(PR, click, openBuiltIn, targets);
      expect(targets.openExternal).toHaveBeenCalledWith(PR);
      expect(openBuiltIn).not.toHaveBeenCalled();
    });

    it('routes a CI check details link the same way', () => {
      const targets = fakeTargets();
      const openBuiltIn = vi.fn();
      const details = 'https://github.com/example-org/widgets/actions/runs/1/job/2';
      routePrLink(details, PLAIN, openBuiltIn, targets);
      expect(openBuiltIn).toHaveBeenCalledWith(details);
    });

    it('falls back to the system browser where the bar has no pane to open', () => {
      const targets = fakeTargets();
      routePrLink(PR, PLAIN, undefined, targets);
      expect(targets.openExternal).toHaveBeenCalledWith(PR);
    });

    it.each(['file:///etc/passwd', 'javascript:alert(1)', 'mailto:someone@example.com', 'not a url'])(
      'refuses %s everywhere',
      url => {
        const targets = fakeTargets();
        const openBuiltIn = vi.fn();
        routePrLink(url, PLAIN, openBuiltIn, targets);
        routePrLink(url, { metaKey: true, ctrlKey: false }, openBuiltIn, targets);
        expect(openBuiltIn).not.toHaveBeenCalled();
        expect(targets.openExternal).not.toHaveBeenCalled();
      }
    );
  });

  describe('openInSessionBrowser', () => {
    it("shows the session's pane and navigates it", async () => {
      const targets = fakeTargets();
      const showPane = vi.fn();
      openInSessionBrowser(PR, 'session-1', showPane, targets);
      expect(showPane).toHaveBeenCalledTimes(1);
      expect(targets.navigate).toHaveBeenCalledWith({ sessionId: 'session-1', url: PR });
      await Promise.resolve();
      expect(targets.openExternal).not.toHaveBeenCalled();
    });

    it('falls back to the system browser with no session', () => {
      const targets = fakeTargets();
      const showPane = vi.fn();
      openInSessionBrowser(PR, null, showPane, targets);
      expect(targets.openExternal).toHaveBeenCalledWith(PR);
      expect(showPane).not.toHaveBeenCalled();
      expect(targets.navigate).not.toHaveBeenCalled();
    });

    it('falls back to the system browser when the pane refuses the navigation', async () => {
      const targets = fakeTargets(async () => {
        throw new Error('refused');
      });
      openInSessionBrowser(PR, 'session-1', vi.fn(), targets);
      await vi.waitFor(() => expect(targets.openExternal).toHaveBeenCalledWith(PR));
    });

    it('refuses a non-web url before touching the pane', () => {
      const targets = fakeTargets();
      const showPane = vi.fn();
      openInSessionBrowser('javascript:alert(1)', 'session-1', showPane, targets);
      expect(showPane).not.toHaveBeenCalled();
      expect(targets.navigate).not.toHaveBeenCalled();
      expect(targets.openExternal).not.toHaveBeenCalled();
    });
  });

  describe('openInSystemBrowser', () => {
    it('opens a web url in the system browser and never the pane', () => {
      const targets = fakeTargets();
      openInSystemBrowser(PR, targets);
      expect(targets.openExternal).toHaveBeenCalledWith(PR);
      expect(targets.navigate).not.toHaveBeenCalled();
    });

    it('refuses a non-web url', () => {
      const targets = fakeTargets();
      openInSystemBrowser('javascript:alert(1)', targets);
      expect(targets.openExternal).not.toHaveBeenCalled();
    });
  });

  describe('isBrowsableUrl', () => {
    it('takes http and https only', () => {
      expect(isBrowsableUrl('https://github.com')).toBe(true);
      expect(isBrowsableUrl('http://localhost:3000')).toBe(true);
      expect(isBrowsableUrl('file:///tmp/x')).toBe(false);
    });
  });
});

describe('prSummaries', () => {
  describe('applyPrSummaryEvents', () => {
    const start: ReadonlyMap<string, PrSummary> = new Map([['a', { number: 1, state: 'open' }]]);

    it('hands back the same map when nothing changed, so the list does not re-render', () => {
      expect(applyPrSummaryEvents(start, [{ sessionId: 'a', summary: { number: 1, state: 'open' } }])).toBe(start);
      expect(applyPrSummaryEvents(start, [{ sessionId: 'b', summary: null }])).toBe(start);
    });

    it('applies a change, a new PR and a removal without touching the original', () => {
      const next = applyPrSummaryEvents(start, [
        { sessionId: 'a', summary: { number: 1, state: 'merged' } },
        { sessionId: 'b', summary: { number: 2, state: 'draft' } },
        { sessionId: 'b', summary: null },
      ]);
      expect(next).not.toBe(start);
      expect([...next]).toEqual([['a', { number: 1, state: 'merged' }]]);
      expect(start.get('a')?.state).toBe('open');
    });
  });
});
