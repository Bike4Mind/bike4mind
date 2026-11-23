import { CssVarsProvider } from '@mui/joy/styles';
import type { ChildOutcome } from '@shared/agentOutcome';
import type { ChatSessionStatus } from '@shared/chat';
import type { PrSummary } from '@shared/pullRequest';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { desktopTheme } from '../theme';
import { renderSidebar } from './prRenderSupport';
import { badgeMarker, SessionBadge } from './SessionBadge';

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
