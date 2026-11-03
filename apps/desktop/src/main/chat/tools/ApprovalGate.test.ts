import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalGate, patternMatches } from './ApprovalGate';
import { commandTokens } from './bashArity';
import { scanShell } from './shellScan';
import type { ChatApprovalAnswer } from '@shared/chat';
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

    await expect(a.answer).resolves.toEqual({ decision: 'once', settledBy: 'user', asked: true });
    await expect(b.answer).resolves.toEqual({ decision: 'deny', settledBy: 'user', asked: true });
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

  it('reports an "always" it did not keep as "once", so callers never record it as standing', async () => {
    const gate = new ApprovalGate();
    for (const options of [{ remember: false }, { rememberable: ['run'] }]) {
      let approvalId = '';
      const answer = gate.request(
        'session-a',
        'bash:rm',
        new AbortController().signal,
        id => (approvalId = id),
        options
      );
      gate.resolve(approvalId, { decision: 'always', optionId: 'redirect' });
      await expect(answer).resolves.toMatchObject({ decision: 'once' });
    }
    expect(gate.isStanding('session-a', 'bash:rm')).toBeNull();
  });

  describe('a card waits for an answer', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('is still pending long after the old ten-minute expiry', async () => {
      vi.useFakeTimers();
      const settled = vi.fn();
      const gate = new ApprovalGate({ requested: vi.fn(), settled });
      const pending = ask(gate, 'session-a');
      const resolved = vi.fn();
      void pending.answer.then(resolved);

      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(resolved).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();

      gate.resolve(pending.approvalId(), { decision: 'once' });
      await expect(pending.answer).resolves.toEqual({ decision: 'once', settledBy: 'user', asked: true });
      expect(settled).toHaveBeenCalledTimes(1);
    });

    it('records a stop as what closed it', async () => {
      const gate = new ApprovalGate();
      const pending = ask(gate, 'session-a');
      pending.controller.abort();
      await expect(pending.answer).resolves.toEqual({ decision: 'deny', settledBy: 'stopped', asked: true });
    });

    it('records a stop that came before the card was shown, without reporting an ask', async () => {
      const requested = vi.fn();
      const settled = vi.fn();
      const gate = new ApprovalGate({ requested, settled });
      const controller = new AbortController();
      controller.abort();
      const answer = gate.request('session-a', 'k', controller.signal, () => {});
      await expect(answer).resolves.toEqual({ decision: 'deny', settledBy: 'stopped', asked: false });
      expect(requested).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
    });

    it('records a deleted conversation and only closes its own cards', async () => {
      const gate = new ApprovalGate();
      const mine = ask(gate, 'session-a');
      const other = ask(gate, 'session-b');
      gate.forgetSession('session-a');
      await expect(mine.answer).resolves.toEqual({ decision: 'deny', settledBy: 'conversation-deleted', asked: true });
      gate.resolve(other.approvalId(), { decision: 'once' });
      await expect(other.answer).resolves.toEqual({ decision: 'once', settledBy: 'user', asked: true });
    });

    it('records the app quitting, and still pairs every request with a settle', async () => {
      const requested = vi.fn();
      const settled = vi.fn();
      const gate = new ApprovalGate({ requested, settled });
      const first = ask(gate, 'session-a');
      const second = ask(gate, 'session-b');
      gate.dispose();
      await expect(first.answer).resolves.toEqual({ decision: 'deny', settledBy: 'app-quit', asked: true });
      await expect(second.answer).resolves.toEqual({ decision: 'deny', settledBy: 'app-quit', asked: true });
      expect(requested).toHaveBeenCalledTimes(2);
      expect(settled).toHaveBeenCalledTimes(2);
    });

    it('closes only question cards when the user moves on', async () => {
      const gate = new ApprovalGate();
      let questionId = '';
      const question = gate.request('session-a', 'q', new AbortController().signal, id => (questionId = id), {
        question: true,
      });
      const approval = ask(gate, 'session-a');
      gate.cancelQuestions('session-a');
      await expect(question).resolves.toEqual({
        decision: 'deny',
        optionId: 'cancelled',
        settledBy: 'moved-on',
        asked: true,
      });
      expect(questionId).not.toBe('');

      gate.resolve(approval.approvalId(), { decision: 'deny' });
      await expect(approval.answer).resolves.toEqual({ decision: 'deny', settledBy: 'user', asked: true });
    });

    it('ignores a click that arrives after the card was closed', async () => {
      const gate = new ApprovalGate();
      const pending = ask(gate, 'session-a');
      pending.controller.abort();
      gate.resolve(pending.approvalId(), { decision: 'once' });
      await expect(pending.answer).resolves.toEqual({ decision: 'deny', settledBy: 'stopped', asked: true });
    });
  });

  it('offers no way to list what other conversations are waiting on', () => {
    const gate = new ApprovalGate() as unknown as Record<string, unknown>;
    expect(gate.pendingApprovals).toBeUndefined();
  });

  it('revokes a standing approval immediately without affecting another session', async () => {
    const gate = new ApprovalGate();
    const first = ask(gate, 'session-a');
    gate.resolve(first.approvalId(), { decision: 'always' });
    await first.answer;
    expect(gate.revoke('session-a', 'bash:rm')).toBe(true);
    expect(gate.revoke('session-a', 'bash:rm')).toBe(false);
    expect(gate.revoke('missing-session', 'bash:rm')).toBe(false);
    expect(gate.isStanding('session-a', 'bash:rm')).toBeNull();
    expect(gate.isStanding('session-b', 'bash:rm')).toBeNull();
  });

  it('reports removal of option-specific approvals and leaves unrelated keys intact', async () => {
    const gate = new ApprovalGate();
    const controller = new AbortController();
    for (const [key, optionId] of [
      ['browser-script:https://example.com', 'signed-in'],
      ['unrelated', 'run'],
    ]) {
      await gate.request(
        'session-a',
        key,
        controller.signal,
        id => {
          gate.resolve(id, { decision: 'always', optionId });
        },
        { rememberable: [optionId] }
      );
    }
    expect(gate.isStanding('session-a', 'browser-script:https://example.com', ['signed-in'])).not.toBeNull();
    expect(gate.revoke('session-a', 'browser-script:https://example.com')).toBe(true);
    expect(gate.isStanding('session-a', 'browser-script:https://example.com', ['signed-in'])).toBeNull();
    expect(gate.isStanding('session-a', 'unrelated', ['run'])).not.toBeNull();
    expect(gate.revoke('session-a', 'browser-script:https://example.com')).toBe(false);
  });

  describe('always allow by prefix', () => {
    const always = (patterns: string[], texts: string[], directories: string[] = []): ApprovalAlways => ({
      namespace: 'bash_execute',
      commands: patterns.map((pattern, index) => ({ pattern, text: texts[index], coverable: true })),
      directories,
    });

    async function allow(gate: ApprovalGate, remembered: ApprovalAlways, tainted = false) {
      const controller = new AbortController();
      let approvalId = '';
      const answer = gate.request('s', 'key', controller.signal, id => (approvalId = id), {
        always: remembered,
        tainted,
      });
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

    it('never covers a command whose normalising dropped something unsafe', async () => {
      const gate = new ApprovalGate();
      await allow(gate, always(['git status *'], ['git status']));
      const stripped = always(['git status *'], ['git status']);
      expect(gate.coversCommands('s', stripped)).toBe(true);
      expect(
        gate.coversCommands('s', { ...stripped, commands: stripped.commands.map(c => ({ ...c, coverable: false })) })
      ).toBe(false);
    });

    it('covers a tainted reply only with prefixes answered over taint', async () => {
      const gate = new ApprovalGate();
      await allow(gate, always(['git status *'], ['git status']));
      const later = always(['git status *'], ['git status --short']);
      expect(gate.coversCommands('s', later)).toBe(true);
      expect(gate.coversCommands('s', later, true)).toBe(false);

      await allow(gate, always(['git diff *', 'git status *'], ['git diff', 'git status']), true);
      expect(gate.coversCommands('s', later, true)).toBe(true);
      expect(gate.coversCommands('s', always(['git diff *'], ['git diff --stat']), true)).toBe(true);
    });

    it('never carries a one-word pattern over taint', async () => {
      const gate = new ApprovalGate();
      await allow(gate, always(['node *'], ['node a.js']), true);
      expect(gate.coversCommands('s', always(['node *'], ['node b.js']), true)).toBe(false);
      expect(gate.coversCommands('s', always(['node *'], ['node b.js']))).toBe(true);
    });

    const scanned = async (command: string): Promise<ApprovalAlways> => {
      const result = await scanShell(command, process.cwd(), [process.cwd()]);
      if (!result) throw new Error('command did not parse');
      return {
        namespace: 'bash_execute',
        commands: result.commands.map(({ always: pattern, ...entry }) => ({ ...entry, pattern })),
        directories: result.directories,
      };
    };
    it.each([
      ['pnpm exec vitest run a.test.ts', 'pnpm exec vitest run b.test.ts'],
      ['pnpm test a', 'pnpm test b'],
      ['make test -j1', 'make test -j2'],
      ['pnpm run node a', 'pnpm run node b'],
      ['bun x vitest run a.test.ts', 'bun x vitest run b.test.ts'],
    ])('carries the bounded prefix from %s over taint', async (first, later) => {
      const gate = new ApprovalGate();
      await allow(gate, await scanned(first), true);
      expect(gate.coversCommands('s', await scanned(later), true)).toBe(true);
    });

    it.each([
      ['pnpm exec -- vitest run', 'pnpm exec -- node -e "process.exit(1)"'],
      ['npm x vitest run', 'npm x some-other-package'],
      ['yarn exec vitest run', 'yarn exec node x.js'],
      ['pnpm exec node a.js', 'pnpm exec node b.js'],
      ['pnpm exec "node" a.js', 'pnpm exec "node" b.js'],
      ['pnpm exec /usr/bin/node a.js', 'pnpm exec /usr/bin/node b.js'],
      ['pnpm node a.js', 'pnpm node b.js'],
      ['pnpm exec tsx a.ts', 'pnpm exec tsx -e "process.exit(1)"'],
      ['npm exec ts-node a.ts', 'npm exec ts-node -e "process.exit(1)"'],
      ['bun x tsx a.ts', 'bun x tsx -e "process.exit(1)"'],
      ['pnpm tsx a.ts', 'pnpm tsx -e "process.exit(1)"'],
      ['pnpm exec pypy3 a.py', 'pnpm exec pypy3 b.py'],
      ['deno run a.js', 'deno run b.js'],
      ['go run a.go', 'go run b.go'],
      ['poetry run pytest', 'poetry run python x.py'],
      ['docker exec container echo ok', 'docker exec container node x.js'],
    ])('does not carry the unbounded runner prefix from %s over taint', async (first, later) => {
      const gate = new ApprovalGate();
      await allow(gate, await scanned(first), true);
      const next = await scanned(later);
      expect(gate.coversCommands('s', next, true)).toBe(false);
    });

    it('never covers an opaque command over taint, whatever was answered', async () => {
      const gate = new ApprovalGate();
      await allow(gate, always(['pnpm exec node *'], ['pnpm exec node -e x']), true);
      const opaque: ApprovalAlways = {
        namespace: 'bash_execute',
        commands: [{ pattern: 'pnpm exec node *', text: 'pnpm exec node -e y', coverable: true, opaque: 'node -e' }],
        directories: [],
      };
      expect(gate.coversCommands('s', opaque)).toBe(true);
      expect(gate.coversCommands('s', opaque, true)).toBe(false);
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

    it('drops shell prefix coverage when its standing grant is revoked', async () => {
      const gate = new ApprovalGate();
      const remembered = always(['git status *'], ['git status']);
      await allow(gate, remembered);
      expect(gate.coversCommands('s', remembered)).toBe(true);
      gate.revoke('s', 'key');
      expect(gate.coversCommands('s', remembered)).toBe(false);
    });

    it('keeps unrelated shell coverage when another grant is revoked', async () => {
      const gate = new ApprovalGate();
      const remembered = always(['git status *'], ['git status']);
      await allow(gate, remembered);
      gate.revoke('s', 'browser-open:https://example.com');
      expect(gate.coversCommands('s', remembered)).toBe(true);
    });

    it('revokes tainted coverage without removing another exact grants normal coverage', async () => {
      const gate = new ApprovalGate();
      const remembered = always(['git status *'], ['git status'], ['/tmp/tainted']);
      await allow(gate, remembered, true);
      await gate.request(
        's',
        'other-key',
        new AbortController().signal,
        id => {
          gate.resolve(id, { decision: 'always' });
        },
        { always: always(['git status *'], ['git status'], ['/tmp/normal']) }
      );
      expect(gate.coversCommands('s', remembered, true)).toBe(true);

      gate.revoke('s', 'key');

      expect(gate.coversCommands('s', remembered)).toBe(true);
      expect(gate.coversCommands('s', remembered, true)).toBe(false);
      expect(gate.uncoveredDirectories('s', ['/tmp/tainted', '/tmp/normal'])).toEqual(['/tmp/tainted']);
    });
  });

  describe('pending cards a later answer covers', () => {
    function waiting(gate: ApprovalGate, sessionId: string, recheck?: () => Promise<ChatApprovalAnswer | null>) {
      let approvalId = '';
      const answer = gate.request(sessionId, 'k', new AbortController().signal, id => (approvalId = id), {
        ...(recheck ? { recheck } : {}),
      });
      return { answer, approvalId: () => approvalId };
    }

    it("settles this conversation's covered cards and leaves the rest waiting", async () => {
      const gate = new ApprovalGate();
      const covered = waiting(gate, 'a', async () => ({ decision: 'once' }));
      const notCovered = waiting(gate, 'a', async () => null);
      const elsewhere = waiting(gate, 'b', async () => ({ decision: 'once' }));
      const noRecheck = waiting(gate, 'a');

      await gate.settleCovered('a');
      await expect(covered.answer).resolves.toEqual({ decision: 'once', settledBy: 'covered', asked: true });

      gate.resolve(notCovered.approvalId(), { decision: 'deny' });
      gate.resolve(noRecheck.approvalId(), { decision: 'deny' });
      await expect(notCovered.answer).resolves.toEqual({ decision: 'deny', settledBy: 'user', asked: true });
      await expect(noRecheck.answer).resolves.toEqual({ decision: 'deny', settledBy: 'user', asked: true });

      // Every conversation's, once a rule is saved.
      await gate.settleCovered();
      await expect(elsewhere.answer).resolves.toEqual({ decision: 'once', settledBy: 'covered', asked: true });
    });

    it('keeps waiting when a recheck fails', async () => {
      const gate = new ApprovalGate();
      const card = waiting(gate, 'a', async () => {
        throw new Error('rules unreadable');
      });
      await gate.settleCovered();
      gate.resolve(card.approvalId(), { decision: 'deny' });
      await expect(card.answer).resolves.toEqual({ decision: 'deny', settledBy: 'user', asked: true });
    });

    it('marks an "always" given on a tainted card as standing over the taint', async () => {
      const gate = new ApprovalGate();
      let approvalId = '';
      const answer = gate.request('a', 'k', new AbortController().signal, id => (approvalId = id), { tainted: true });
      gate.resolve(approvalId, { decision: 'always' });
      await answer;
      expect(gate.isStanding('a', 'k')).toEqual({ overTaint: true });

      const plain = ask(gate, 'a', 'other');
      gate.resolve(plain.approvalId(), { decision: 'always' });
      await plain.answer;
      expect(gate.isStanding('a', 'other')).toEqual({});
    });
  });
});
