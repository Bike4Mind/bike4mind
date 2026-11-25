import { CssVarsProvider } from '@mui/joy/styles';
import type { ChildOutcome } from '@shared/agentOutcome';
import type { ChatSessionStatus, SessionBackgroundJobs, SessionSetupStep } from '@shared/chat';
import type { PrSummary } from '@shared/pullRequest';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { desktopTheme } from '../theme';
import { renderSidebar } from './prRenderSupport';
import { badgeMarker, SessionBadge } from './SessionBadge';
import {
  applyBackgroundEvents,
  applyPreparingEvents,
  applyStatusEvents,
  applyUnreadReplyEvents,
  STATUS_LABEL,
} from './sessionStatus';

describe('SessionBadge', () => {
  function renderBadge(
    props: { status: ChatSessionStatus; outcome?: ChildOutcome; pr?: PrSummary; deciding?: boolean },
    mode: 'light' | 'dark' = 'light'
  ): string {
    return renderToStaticMarkup(
      <CssVarsProvider theme={desktopTheme} defaultMode={mode}>
        <SessionBadge {...props} />
      </CssVarsProvider>
    );
  }

  const PR = { number: 42, state: 'merged' } as const;

  describe('SessionBadge with a PR', () => {
    it('keeps the plain idle dot for a session with no PR', () => {
      const html = renderSidebar(undefined);
      expect(html).toContain('data-status="done"');
      expect(html).not.toContain('data-pr-state');
      expect(html).not.toContain('data-session-pr-state');
    });

    it('puts the PR icon in place of the dot, named for its number and state', () => {
      const html = renderSidebar(PR);
      expect(html).toContain('data-session-status="done" data-session-pr-state="merged"');
      expect(html).toContain('title="PR #42 - Merged"');
      expect(html).toContain('aria-label="PR #42 - Merged"');
    });

    it('names a PR in the merge queue as queued to merge', () => {
      const html = renderSidebar({ number: 42, state: 'queued' });
      expect(html).toContain('data-session-pr-state="queued"');
      expect(html).toContain('title="PR #42 - Queued to merge"');
    });

    it('lets a failed last turn outrank the PR icon', () => {
      const html = renderBadge({ status: 'done', outcome: 'failed', pr: PR });
      expect(html).toContain('data-state="failed"');
      expect(html).toContain('title="Failed"');
      expect(html).not.toContain('PR #42');
    });

    it.each(['processing', 'needs-action'] as const)('lets a live %s status outrank the PR icon', status => {
      const html = renderSidebar(PR, status);
      expect(html).toContain(`data-session-status="${status}" data-session-pr-state="merged"`);
      expect(html).toContain(`data-testid="session-status-badge" data-status="${status}"`);
      expect(html).not.toMatch(/data-pr-state="merged" data-pr-color/);
      expect(html).not.toContain('PR #42');
    });
  });

  describe('badgeMarker', () => {
    it.each([
      ['processing', undefined, false, 'working'],
      ['processing', 'failed', true, 'working'],
      ['needs-action', 'finished', true, 'needs-you'],
      ['done', 'failed', true, 'failed'],
      ['done', 'finished', true, 'pr'],
      ['done', 'aborted', true, 'pr'],
      ['done', 'aborted', false, 'idle'],
      ['done', 'turn-budget', false, 'stopped'],
      ['done', 'context-limit', false, 'stopped'],
      ['done', 'finished', false, 'idle'],
      ['done', 'max-tokens', false, 'idle'],
      ['done', 'no-reply', false, 'idle'],
      ['done', undefined, false, 'idle'],
    ] as const)('%s + %s (pr: %s) shows %s', (status, outcome, hasPr, expected) => {
      expect(badgeMarker(status, outcome, hasPr)).toBe(expected);
    });
  });

  describe('SessionBadge markers', () => {
    it.each(['light', 'dark'] as const)('draws one trackless spinner in the working colour (%s)', mode => {
      const html = renderBadge({ status: 'processing' }, mode);
      expect(html).toContain('data-state="working"');
      expect(html).toContain('data-testid="session-status-spinner"');
      expect(html).toContain('title="Working"');
      expect(html).toContain('border-color:var(--joy-palette-primary-plainColor)');
      expect(html).not.toContain('border-top-color');
    });

    it('keeps the spinner the same whatever the outcome of an earlier turn', () => {
      const strip = (html: string) => html.replace(/ data-(status|state)="[^"]*"/g, '');
      expect(strip(renderBadge({ status: 'processing', outcome: 'failed' }))).toBe(
        strip(renderBadge({ status: 'processing' }))
      );
    });

    it('names a waiting worker decision precisely', () => {
      expect(renderBadge({ status: 'needs-action' })).toContain('title="Needs you"');
      expect(renderBadge({ status: 'needs-action', deciding: true })).toContain('title="Needs your decision"');
    });

    it.each([
      ['failed', 'Failed'],
      ['turn-budget', 'Stopped'],
      ['aborted', 'Idle'],
      ['finished', 'Idle'],
    ] as const)('labels a %s session %s', (outcome, label) => {
      const html = renderBadge({ status: 'done', outcome });
      expect(html).toContain(`title="${label}"`);
      expect(html).toContain(`aria-label="${label}"`);
    });

    it('draws a cross for a failed session and no spinner', () => {
      const html = renderBadge({ status: 'done', outcome: 'failed' }, 'dark');
      expect(html).toContain('<svg');
      expect(html).toContain('aria-hidden="true"');
      expect(html).not.toContain('session-status-spinner');
    });
  });
});

describe('sessionStatus', () => {
  const empty: ReadonlyMap<string, ChatSessionStatus> = new Map();

  describe('applyUnreadReplyEvents', () => {
    it('tracks unread replies independently of live attention without mutating prior state', () => {
      const none = new Set<string>();
      const unread = applyUnreadReplyEvents(none, [{ sessionId: 'a', status: 'needs-action', unreadReply: true }]);
      expect([...unread]).toEqual(['a']);
      expect(none.size).toBe(0);
      expect(applyUnreadReplyEvents(unread, [{ sessionId: 'a', status: 'needs-action', unreadReply: true }])).toBe(
        unread
      );
      expect(applyUnreadReplyEvents(unread, [{ sessionId: 'a', status: 'needs-action' }]).size).toBe(0);
      expect(applyUnreadReplyEvents(unread, [{ sessionId: 'a', status: 'done' }]).size).toBe(0);
      expect(
        applyUnreadReplyEvents(none, [
          { sessionId: 'a', status: 'needs-action', unreadReply: true },
          { sessionId: 'a', status: 'processing' },
        ]).size
      ).toBe(0);
    });
  });

  describe('applyStatusEvents', () => {
    it('records a busy session', () => {
      const next = applyStatusEvents(empty, [{ sessionId: 'a', status: 'processing' }]);
      expect(next.get('a')).toBe('processing');
    });

    it('stores idle as absence rather than as a value', () => {
      const busy = applyStatusEvents(empty, [{ sessionId: 'a', status: 'processing' }]);
      const idle = applyStatusEvents(busy, [{ sessionId: 'a', status: 'done' }]);

      expect(idle.has('a')).toBe(false);
      expect(idle.size).toBe(0);
    });

    // The sidebar re-renders on identity, so a repeated status must not produce a new map.
    it('returns the same map when nothing changed', () => {
      const busy = applyStatusEvents(empty, [{ sessionId: 'a', status: 'processing' }]);

      expect(applyStatusEvents(busy, [{ sessionId: 'a', status: 'processing' }])).toBe(busy);
      expect(applyStatusEvents(busy, [])).toBe(busy);
      expect(applyStatusEvents(empty, [{ sessionId: 'b', status: 'done' }])).toBe(empty);
    });

    it('never mutates the map it was given', () => {
      const busy = applyStatusEvents(empty, [{ sessionId: 'a', status: 'processing' }]);
      applyStatusEvents(busy, [{ sessionId: 'a', status: 'done' }]);

      expect(busy.get('a')).toBe('processing');
    });

    it('lets a later event in the same batch overtake an earlier one', () => {
      const next = applyStatusEvents(empty, [
        { sessionId: 'a', status: 'processing' },
        { sessionId: 'a', status: 'needs-action' },
        { sessionId: 'a', status: 'processing' },
        { sessionId: 'a', status: 'done' },
      ]);

      expect(next.has('a')).toBe(false);
    });

    it('keeps sessions apart', () => {
      const next = applyStatusEvents(empty, [
        { sessionId: 'a', status: 'processing' },
        { sessionId: 'b', status: 'needs-action' },
      ]);

      expect(next.get('a')).toBe('processing');
      expect(next.get('b')).toBe('needs-action');
    });

    it('names every state, so a badge always has a label', () => {
      const states: ChatSessionStatus[] = ['processing', 'needs-action', 'done'];
      for (const state of states) expect(STATUS_LABEL[state]).toBeTruthy();
    });
  });

  describe('applyPreparingEvents', () => {
    const none: ReadonlyMap<string, SessionSetupStep> = new Map();

    it('tracks the step of a preparing event, and removes on one without it', () => {
      const preparing = applyPreparingEvents(none, [{ sessionId: 'a', status: 'processing', preparing: 'worktree' }]);
      expect(preparing.get('a')).toBe('worktree');

      const starting = applyPreparingEvents(preparing, [
        { sessionId: 'a', status: 'processing', preparing: 'starting' },
      ]);
      expect(starting.get('a')).toBe('starting');

      const replying = applyPreparingEvents(starting, [{ sessionId: 'a', status: 'processing' }]);
      expect(replying.has('a')).toBe(false);
      expect(preparing.get('a')).toBe('worktree');
    });

    it('returns the same map when nothing changed', () => {
      const preparing = applyPreparingEvents(none, [{ sessionId: 'a', status: 'processing', preparing: 'worktree' }]);

      expect(applyPreparingEvents(preparing, [{ sessionId: 'a', status: 'processing', preparing: 'worktree' }])).toBe(
        preparing
      );
      expect(applyPreparingEvents(none, [{ sessionId: 'b', status: 'done' }])).toBe(none);
    });
  });

  describe('applyBackgroundEvents', () => {
    const none: ReadonlyMap<string, SessionBackgroundJobs> = new Map();
    const jobs = { running: 1, label: 'pnpm test' };

    it('records jobs on a done session and clears them on an event without any', () => {
      const waiting = applyBackgroundEvents(none, [{ sessionId: 'a', status: 'done', background: jobs }]);
      expect(waiting.get('a')).toEqual(jobs);

      const cleared = applyBackgroundEvents(waiting, [{ sessionId: 'a', status: 'done' }]);
      expect(cleared.has('a')).toBe(false);
    });

    it('returns the same map when nothing changed', () => {
      const waiting = applyBackgroundEvents(none, [{ sessionId: 'a', status: 'done', background: jobs }]);
      expect(applyBackgroundEvents(waiting, [{ sessionId: 'a', status: 'done', background: { ...jobs } }])).toBe(
        waiting
      );
      expect(applyBackgroundEvents(none, [{ sessionId: 'b', status: 'processing' }])).toBe(none);
    });

    it('updates the count and label as jobs start and end', () => {
      const one = applyBackgroundEvents(none, [{ sessionId: 'a', status: 'done', background: jobs }]);
      const two = applyBackgroundEvents(one, [
        { sessionId: 'a', status: 'done', background: { running: 2, label: 'pnpm build' } },
      ]);
      expect(two.get('a')).toEqual({ running: 2, label: 'pnpm build' });
    });
  });
});
