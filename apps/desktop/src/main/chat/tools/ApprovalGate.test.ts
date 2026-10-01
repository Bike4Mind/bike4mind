import { describe, expect, it, vi } from 'vitest';
import { ApprovalGate, patternMatches } from './ApprovalGate';
import { commandTokens } from './bashArity';
import type { ApprovalAlways } from './types';

/**
 * The gate keeps no cross-session view of what is waiting: an approval is answered in the
 * conversation that raised it, and `requested`/`settled` are all the sidebar needs to say a
 * session is blocked.
 */
function ask(gate: ApprovalGate, sessionId: string, key = 'bash:rm') {
  const controller = new AbortController();
  let approvalId = '';
  const answer = gate.request(sessionId, key, controller.signal, id => {
    approvalId = id;
  });
  return { answer, approvalId: () => approvalId, controller };
}

describe('ApprovalGate', () => {
  it('resolves the request its own approvalId answers', async () => {
    const gate = new ApprovalGate();
    const a = ask(gate, 'session-a');
    const b = ask(gate, 'session-b');

    gate.resolve(a.approvalId(), { decision: 'once' });
    gate.resolve(b.approvalId(), { decision: 'deny' });

    await expect(a.answer).resolves.toEqual({ decision: 'once' });
    await expect(b.answer).resolves.toEqual({ decision: 'deny' });
  });

  it('reports the session that is waiting, and that it stopped', async () => {
    const requested = vi.fn();
    const settled = vi.fn();
    const gate = new ApprovalGate({ requested, settled });

    const pending = ask(gate, 'session-a');
    expect(requested).toHaveBeenCalledWith('session-a');
    expect(settled).not.toHaveBeenCalled();

    gate.resolve(pending.approvalId(), { decision: 'once' });
    await pending.answer;
    expect(settled).toHaveBeenCalledWith('session-a');
  });

  it('replays a standing answer only for the session that gave it', async () => {
    const gate = new ApprovalGate();
    const first = ask(gate, 'session-a');
    gate.resolve(first.approvalId(), { decision: 'always' });
    await first.answer;

    expect(gate.isStanding('session-a', 'bash:rm')).toEqual({});
    expect(gate.isStanding('session-b', 'bash:rm')).toBeNull();
  });

  it('offers no way to list what other conversations are waiting on', () => {
    const gate = new ApprovalGate() as unknown as Record<string, unknown>;
    expect(gate.pendingApprovals).toBeUndefined();
  });

  describe('always allow by prefix', () => {
    const always = (patterns: string[], texts: string[], directories: string[] = []): ApprovalAlways => ({
      namespace: 'bash_execute',
      commands: patterns.map((pattern, index) => ({ pattern, text: texts[index] })),
      directories,
    });

    async function allow(gate: ApprovalGate, remembered: ApprovalAlways) {
      const controller = new AbortController();
      let approvalId = '';
      const answer = gate.request('s', 'key', controller.signal, id => (approvalId = id), { always: remembered });
      gate.resolve(approvalId, { decision: 'always' });
      await answer;
    }

    it('matches a trailing star against the bare command too', () => {
      expect(patternMatches('git commit *', 'git commit')).toBe(true);
      expect(patternMatches('git commit *', 'git commit -m "a b"')).toBe(true);
      expect(patternMatches('git commit *', 'git commits')).toBe(false);
      expect(patternMatches('ls *', 'lsof -i')).toBe(false);
      expect(patternMatches('git commit *', 'git status')).toBe(false);
    });

    it('covers a later compound command only when every sub-command matches', async () => {
      const gate = new ApprovalGate();
      await allow(gate, always(['git commit *'], ['git commit -m x']));

      const covered = always(['git commit *', 'git commit *'], ['git commit -m a', 'git commit -m b']);
      expect(gate.coversCommands('s', covered)).toBe(true);
      const mixed = always(['git commit *', 'rm *'], ['git commit -m a', 'rm -rf x']);
      expect(gate.coversCommands('s', mixed)).toBe(false);
      expect(gate.coversCommands('other', covered)).toBe(false);
    });

    it('matches after the same option-skipping the pattern was derived with', () => {
      expect(patternMatches('git commit *', commandTokens(['git', '-C', 'sub', 'commit', '-m', 'x']).join(' '))).toBe(
        true
      );
      expect(
        patternMatches(
          'pnpm exec vitest *',
          commandTokens(['pnpm', '--filter', '@a/b', 'exec', 'vitest', 'run']).join(' ')
        )
      ).toBe(true);
      expect(
        patternMatches('pnpm exec vitest *', commandTokens(['pnpm', '--filter', '@a/b', 'exec', 'rm']).join(' '))
      ).toBe(false);
    });

    it('keeps the two shell tools apart', async () => {
      const gate = new ApprovalGate();
      await allow(gate, always(['npm run dev *'], ['npm run dev']));
      const background = { ...always(['npm run dev *'], ['npm run dev']), namespace: 'bash_background' };
      expect(gate.coversCommands('s', background)).toBe(false);
    });

    it('remembers a directory for everything beneath it', async () => {
      const gate = new ApprovalGate();
      await allow(gate, always(['cat *'], ['cat /etc/hosts'], ['/etc']));
      expect(gate.uncoveredDirectories('s', ['/etc', '/etc/ssl', '/etcetera', '/var'])).toEqual(['/etcetera', '/var']);
    });

    it('forgets everything when the conversation is deleted', async () => {
      const gate = new ApprovalGate();
      await allow(gate, always(['ls *'], ['ls']));
      gate.forgetSession('s');
      expect(gate.coversCommands('s', always(['ls *'], ['ls']))).toBe(false);
    });
  });
});
