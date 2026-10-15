import { describe, expect, it } from 'vitest';
import { renderSidebar } from './prRenderSupport';

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

  it.each(['processing', 'needs-action'] as const)('lets a live %s status outrank the PR icon', status => {
    const html = renderSidebar(PR, status);
    expect(html).toContain(`data-session-status="${status}" data-session-pr-state="merged"`);
    expect(html).toContain(`data-testid="session-status-badge" data-status="${status}"`);
    expect(html).not.toMatch(/data-pr-state="merged" data-pr-color/);
    expect(html).not.toContain('PR #42');
  });
});
