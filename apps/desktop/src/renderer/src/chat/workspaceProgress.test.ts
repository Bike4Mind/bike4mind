import { describe, expect, it } from 'vitest';
import type { ChatProject } from '@shared/chat';
import { applyWorkspaceEvent, preparingOnSend, workspacePhrase } from './workspaceProgress';

const pending: ChatProject = {
  directory: '/repo',
  name: 'repo',
  branch: 'main',
  workspace: true,
  workingDirectory: '/repo',
  contextDirectories: [],
};

const event = (running: boolean, branch?: string) =>
  ({ type: 'workspace', sessionId: 's', running, base: 'main', ...(branch ? { branch } : {}) }) as const;

describe('preparingOnSend', () => {
  it('shows the wait on the send that will cut the worktree', () => {
    expect(preparingOnSend(pending, false, 100)).toEqual({ since: 100, base: 'main' });
  });

  it('shows nothing once the session is in its worktree', () => {
    const moved = { ...pending, workspaceBranch: 'b4m/x-abc123', workingDirectory: '/repo/.b4m/worktrees/b4m+x' };
    expect(preparingOnSend(moved, false, 100)).toBeNull();
  });

  it('shows nothing with the toggle off, with no project, or behind a live turn', () => {
    expect(preparingOnSend({ ...pending, workspace: false }, false, 100)).toBeNull();
    expect(preparingOnSend(undefined, false, 100)).toBeNull();
    expect(preparingOnSend(pending, true, 100)).toBeNull();
  });
});

describe('applyWorkspaceEvent', () => {
  it('names the branch once main has chosen it, keeping the clock that started on send', () => {
    const shown = applyWorkspaceEvent({ since: 100, base: 'main' }, event(true, 'b4m/fix-abc123'), 500, true);
    expect(shown).toEqual({ since: 100, base: 'main', branch: 'b4m/fix-abc123' });
  });

  it('starts the clock for a window that did not send', () => {
    expect(applyWorkspaceEvent(null, event(true), 500, false)).toEqual({ since: 500, base: 'main' });
  });

  it('clears when the worktree step ends in a window with no send out', () => {
    expect(applyWorkspaceEvent({ since: 100, base: 'main', branch: 'b' }, event(false), 500, false)).toBeNull();
  });

  it('holds through the end of the step while this window waits on its own send', () => {
    const current = { since: 100, base: 'main', branch: 'b' };
    expect(applyWorkspaceEvent(current, event(false), 500, true)).toBe(current);
  });
});

describe('workspacePhrase', () => {
  it('reads the base before the branch is known, and the branch after', () => {
    expect(workspacePhrase({ since: 0, base: 'main' })).toBe('Preparing worktree on main...');
    expect(workspacePhrase({ since: 0, base: 'main', branch: 'b4m/fix-abc123' })).toBe(
      'Creating branch b4m/fix-abc123 and worktree...'
    );
  });
});
