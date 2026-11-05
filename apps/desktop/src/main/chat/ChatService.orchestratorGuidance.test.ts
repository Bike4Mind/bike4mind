import { describe, expect, it } from 'vitest';
import { buildSystemMessage, MAX_CONCURRENT_SPAWNED, worktreePreamble } from './ChatService';

const build = (roots: string[], host: boolean, orchestrate: boolean): string =>
  String(
    buildSystemMessage(
      roots,
      false,
      host,
      false,
      [],
      undefined,
      [],
      '',
      false,
      false,
      false,
      '',
      true,
      '',
      false,
      false,
      false,
      orchestrate
    ).content
  );

describe('ORCHESTRATOR_GUIDANCE', () => {
  it.each([[['/work']], [[]]])('steers an orchestrating session to delegate (roots %j)', roots => {
    const text = build(roots, true, true);
    expect(text).toContain('you are coordinating agents');
    expect(text).toContain('session_spawn STARTS');
    expect(text).toContain('Do not do the delegated work yourself');
    expect(text).toContain('Spawn early');
    expect(text).toContain('do only a brief survey');
    expect(text).toContain('leave the detailed reading to the agents');
    expect(text).toContain(`At most ${MAX_CONCURRENT_SPAWNED} agents run at once`);
    expect(text).toContain('session_list and session_read');
    expect(text).toContain("so I didn't start any agents.");
  });

  it('says spawned agents get their own worktrees and that the parent is woken, not left polling', () => {
    const text = build(['/work'], true, true);
    expect(text).toContain('its own isolated worktree and branch');
    expect(text).toContain('never create worktrees or branches for agents');
    expect(text).toContain('never remove an agent worktree or delete');
    expect(text).toContain('Merging agent branches into your own branch');
    expect(text).toContain('Never use git stash, and tell agents not to');
    expect(text).toContain('the app wakes this conversation');
    expect(text).toContain('rather than polling or sleeping');
  });

  it('asks for quest_complete with the final summary, and never for an interim update', () => {
    const text = build(['/work'], true, true);
    expect(text).toContain('write the final');
    expect(text).toContain('call quest_complete in that same reply');
    expect(text).toContain('Never call it for an interim');
  });

  it('is left out when the session does not orchestrate', () => {
    expect(build(['/work'], true, false)).not.toContain('coordinating agents');
  });

  it('is left out without the host tools, which are what it would steer toward', () => {
    expect(build(['/work'], false, true)).not.toContain('coordinating agents');
    expect(build([], false, true)).not.toContain('coordinating agents');
  });
});

describe('worktreePreamble', () => {
  it('tells a spawned agent to keep off the shared git stash', () => {
    const text = worktreePreamble('/repo', { branch: 'agent/x', base: 'main', workingDirectory: '/wt/x' });
    expect(text).toContain('Never use git stash');
    expect(text).toContain('shared by every worktree');
    expect(text.endsWith(']')).toBe(true);
  });
});
