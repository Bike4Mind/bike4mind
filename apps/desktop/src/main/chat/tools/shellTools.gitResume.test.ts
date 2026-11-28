import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runsCheckedInAuto, runsCheckedInFull } from './shellApproval.testHelper';
import { shellApproval } from './shellTools';
import type { ToolContext } from './types';

vi.mock('./userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('./userPath')>()),
  resolveLoginShellVariables: async () => ({}),
  resolveUserPath: vi.fn(async () => process.env.PATH ?? ''),
}));

/**
 * Resuming or stopping a merge, rebase or cherry-pick in progress: the scan reads the state git keeps for it, so a
 * step runs unasked unless what it writes reaches a protected path or the state names a command to run.
 */
describe('shell approval of a git step resuming or stopping one in progress', () => {
  let base: string;
  let userData: string;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
  };

  const write = (path: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };

  /** Runs git in `repo`, ignoring the exit code of a step expected to stop on a conflict. */
  const git = (repo: string, args: string[], stops = false): void => {
    try {
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
        cwd: repo,
        env,
        stdio: 'pipe',
      });
    } catch (error) {
      if (!stops) throw error;
    }
  };

  const commit = (repo: string, files: Record<string, string>, message: string): void => {
    for (const [name, text] of Object.entries(files)) write(join(repo, name), text);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', message]);
  };

  /**
   * A repository whose `topic` branch first conflicts with main on a.ts, then commits `next`. `start` runs the step
   * that stops on that conflict.
   */
  const stopped = (name: string, next: Record<string, string>, start: string[], onTopic = true): string => {
    const repo = join(base, name);
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    commit(repo, { 'a.ts': 'a\n', '.claude/settings.json': '{}\n' }, 'first');
    git(repo, ['checkout', '-qb', 'topic']);
    commit(repo, { 'a.ts': 'topic\n' }, 'conflicting');
    commit(repo, next, 'next');
    git(repo, ['checkout', '-q', 'main']);
    commit(repo, { 'a.ts': 'main\n' }, 'main');
    if (onTopic) git(repo, ['checkout', '-q', 'topic']);
    git(repo, start, true);
    return repo;
  };

  const cells = async (command: string, repo: string): Promise<{ auto: boolean; full: boolean }> => {
    const context: ToolContext = {
      roots: [base],
      workingDirectory: repo,
      signal: new AbortController().signal,
      protectedPaths: [userData],
    };
    const prompt = await shellApproval('bash_execute', { command, cwd: repo }, context);
    return { auto: runsCheckedInAuto(prompt), full: runsCheckedInFull(prompt) };
  };

  const runs = { auto: true, full: true };
  const asks = { auto: false, full: false };

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'b4m-gitresume-')));
    const home = join(base, 'home');
    userData = join(home, '.config', 'Bike4Mind');
    mkdirSync(userData, { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  describe('a rebase stopped on a conflict', () => {
    it('runs --continue, --skip and --abort when the commits left and the branch write no protected path', async () => {
      const repo = stopped('rebase-plain', { 'b.ts': 'b\n' }, ['rebase', 'main']);
      for (const command of ['git rebase --continue', 'git rebase --skip', 'git rebase --abort', 'git rebase --quit']) {
        expect(await cells(command, repo), command).toEqual(runs);
      }
    });

    it('asks in every mode before --continue applies a commit writing a protected path', async () => {
      const repo = stopped('rebase-settings', { '.claude/settings.json': '{"x":1}\n' }, ['rebase', 'main']);
      expect(await cells('git rebase --continue', repo)).toEqual(asks);
      // The branch it returns to holds that write as well.
      expect(await cells('git rebase --abort', repo)).toEqual(asks);
      expect(await cells('git rebase --quit', repo)).toEqual(runs);
    });

    it('asks in every mode before --continue when the todo list runs a command', async () => {
      const repo = stopped('rebase-exec', { 'b.ts': 'b\n' }, ['rebase', '-x', 'true', 'main']);
      expect(await cells('git rebase --continue', repo)).toEqual(asks);
      expect(await cells('git rebase --skip', repo)).toEqual(asks);
    });

    it('asks in every mode before a step that applies an autostash', async () => {
      const repo = stopped('rebase-autostash', { 'b.ts': 'b\n' }, ['rebase', '--autostash', 'main'], false);
      git(repo, ['checkout', '-q', 'topic']);
      write(join(repo, 'b.ts'), 'local\n');
      git(repo, ['rebase', '--autostash', 'main'], true);
      expect(await cells('git rebase --abort', repo)).toEqual(asks);
    });

    it('asks in every mode before a step that signs or runs a merge strategy saved for the rebase', async () => {
      const signs = stopped('rebase-sign', { 'b.ts': 'b\n' }, ['rebase', 'main']);
      write(join(signs, '.git', 'rebase-merge', 'gpg_sign_opt'), '-S');
      expect(await cells('git rebase --continue', signs)).toEqual(asks);
      const strategy = stopped('rebase-strategy', { 'b.ts': 'b\n' }, ['rebase', 'main']);
      write(join(strategy, '.git', 'rebase-merge', 'strategy'), 'custom');
      expect(await cells('git rebase --skip', strategy)).toEqual(asks);
    });

    it('asks in every mode before a step of the apply backend', async () => {
      const repo = stopped('rebase-apply', { 'b.ts': 'b\n' }, ['rebase', '--apply', 'main']);
      expect(await cells('git rebase --continue', repo)).toEqual(asks);
    });

    it('asks in every mode once an earlier command in the script may have moved refs', async () => {
      const repo = stopped('rebase-moved', { 'b.ts': 'b\n' }, ['rebase', 'main']);
      expect(await cells('git checkout main && git rebase --continue', repo)).toEqual(asks);
    });
  });

  describe('a cherry-pick sequence stopped on a conflict', () => {
    it('reads the commits still to pick', async () => {
      const plain = stopped('pick-plain', { 'b.ts': 'b\n' }, ['cherry-pick', 'main..topic'], false);
      expect(await cells('git cherry-pick --continue', plain)).toEqual(runs);
      expect(await cells('git cherry-pick --abort', plain)).toEqual(runs);
      const settings = stopped(
        'pick-settings',
        { '.claude/settings.json': '{"x":1}\n' },
        ['cherry-pick', 'main..topic'],
        false
      );
      expect(await cells('git cherry-pick --continue', settings)).toEqual(asks);
      expect(await cells('git cherry-pick --skip', settings)).toEqual(asks);
    });

    it('asks in every mode before --abort returns to a branch holding a protected write', async () => {
      const repo = stopped('pick-abort', { 'b.ts': 'b\n' }, ['status'], false);
      commit(repo, { '.claude/settings.json': '{"x":1}\n' }, 'settings on main');
      git(repo, ['cherry-pick', 'main..topic'], true);
      git(repo, ['reset', '-q', '--hard', 'HEAD~1']);
      expect(await cells('git cherry-pick --abort', repo)).toEqual(asks);
    });

    it('asks in every mode before a step that signs, picks a merge program or applies another parent', async () => {
      for (const option of ['gpg-sign = -S', 'strategy = custom', 'mainline = 2']) {
        const repo = stopped(`pick-${option.split(' ')[0]}`, { 'b.ts': 'b\n' }, ['cherry-pick', 'main..topic'], false);
        write(join(repo, '.git', 'sequencer', 'opts'), `[options]\n\t${option}\n`);
        expect(await cells('git cherry-pick --continue', repo), option).toEqual(asks);
      }
    });

    it('reads the commits a revert sequence still undoes', async () => {
      // Reverting the conflicting commit stops on the later change to a.ts, leaving `next` to undo.
      const reverting = (name: string, next: Record<string, string>): string => {
        const repo = stopped(name, next, ['status']);
        commit(repo, { 'a.ts': 'later\n' }, 'later');
        git(repo, ['revert', '--no-edit', 'HEAD~2', 'HEAD~1'], true);
        return repo;
      };
      expect(await cells('git revert --continue', reverting('revert-plain', { 'b.ts': 'b\n' }))).toEqual(runs);
      const settings = reverting('revert-settings', { '.claude/settings.json': '{"x":1}\n' });
      expect(await cells('git revert --continue', settings)).toEqual(asks);
    });
  });

  describe('a merge stopped on a conflict', () => {
    it('runs --continue and --abort', async () => {
      const repo = stopped('merge-plain', { 'b.ts': 'b\n' }, ['merge', 'topic'], false);
      expect(await cells('git merge --continue', repo)).toEqual(runs);
      expect(await cells('git merge --abort', repo)).toEqual(runs);
    });

    it('asks in every mode before a step that applies an autostash', async () => {
      const repo = stopped('merge-autostash', { 'b.ts': 'b\n' }, ['status'], false);
      write(join(repo, '.claude', 'settings.json'), '{"local":1}\n');
      git(repo, ['merge', '--autostash', 'topic'], true);
      expect(await cells('git merge --abort', repo)).toEqual(asks);
    });
  });

  describe('a target that names no commit', () => {
    it('runs a merge-family call git stops before writing', async () => {
      const repo = stopped('missing', { 'b.ts': 'b\n' }, ['status'], false);
      for (const command of ['git merge nope', 'git rebase nope', 'git cherry-pick nope', 'git stash pop']) {
        expect(await cells(command, repo), command).toEqual(runs);
      }
    });

    it('asks in every mode for a spelling the commit probe cannot read as git does', async () => {
      const repo = stopped('spellings', { '.claude/settings.json': '{"x":1}\n' }, ['status'], false);
      git(repo, ['stash', 'push', '-q', '--allow-empty'], true);
      write(join(repo, '.claude', 'settings.json'), '{"y":1}\n');
      git(repo, ['stash', 'push', '-q']);
      git(repo, ['stash', 'push', '-q', '--include-untracked'], true);
      expect(await cells('git merge :/next', repo)).toEqual(asks);
      expect(await cells('git cherry-pick :/next', repo)).toEqual(asks);
      expect(await cells('git stash apply 0', repo)).toEqual(asks);
    });

    it('asks in every mode when an earlier command in the script may have made it', async () => {
      const repo = stopped('missing-moved', { 'b.ts': 'b\n' }, ['status'], false);
      expect(await cells('git branch nope topic && git merge nope', repo)).toEqual(asks);
    });
  });
});
