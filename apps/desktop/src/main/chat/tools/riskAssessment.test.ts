import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { assessApprovalRisk, spendsCredits } from './riskAssessment';
import type { ApprovalPrompt, ToolContext } from './types';

const NO_PROMPT: ApprovalPrompt = { detail: '', key: 'k' };

describe('assessApprovalRisk', () => {
  let root: string;
  let context: ToolContext;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-risk-')));
    await writeFile(join(root, 'notes.txt'), 'hello\n', 'utf8');
    context = { roots: [root], workingDirectory: root, signal: new AbortController().signal };
  });

  const shell = (command: string, input: Record<string, unknown> = {}) =>
    assessApprovalRisk('bash_execute', { command, ...input }, NO_PROMPT, context);

  const write = (path: string) =>
    assessApprovalRisk(
      'file_write',
      { path, content: 'x' },
      { detail: '', key: 'k', diff: { path, operation: 'create', added: 1, removed: 0, lines: [] } },
      context
    );

  describe('shell commands that may run unattended', () => {
    it.each([
      'git status',
      'git log --oneline -20',
      'git diff HEAD',
      'ls -la',
      'cat notes.txt',
      'grep -rn todo .',
      'wc -l notes.txt',
      `cat ${join('{ROOT}', 'notes.txt')}`,
      'jq .name package.json',
      'git merge-base HEAD main',
      'git show-ref --heads',
      'git reflog',
    ])('allows %s', async command => {
      expect(await shell(command.replace('{ROOT}', root))).toBe('contained');
    });

    /**
     * The quoting that used to be refused outright. An argument the shell hands over verbatim
     * is still one fixed argv, which is all the per-token checks ever needed.
     */
    it.each([
      ['a quoted argument with a space', 'grep "foo bar" notes.txt'],
      ['a quoted glob, which the shell never expands', "find . -name '*.ts'"],
      ['a single-quoted argument', "grep 'foo bar' notes.txt"],
    ])('allows %s', async (_label, command) => {
      expect(await shell(command)).toBe('contained');
    });

    /**
     * A pipeline of inert commands is still inert: nothing on the allow-list writes to a file,
     * so no chain of them can, and a redirect is rejected while tokenizing.
     */
    it.each(['cat notes.txt | head -50', 'git log --oneline | head -20', 'grep -rn todo . | sort | uniq -c'])(
      'allows %s',
      async command => {
        expect(await shell(command)).toBe('contained');
      }
    );

    /** Bare and listing forms read; the block below holds the forms that do not. */
    it.each(['git branch', 'git branch -a', 'git branch --list'])('allows %s', async command => {
      expect(await shell(command)).toBe('contained');
    });
  });

  /**
   * Commands that read in their bare form and write once given an argument. Each of these is on
   * the allow-list, so the only thing standing between them and the disk is the bound here.
   */
  describe('allowed commands that write when given the right argument', () => {
    it.each([
      ['sort writing its output to a file', 'sort -o out.txt notes.txt'],
      ['sort spelling the same flag out', 'sort --output=out.txt notes.txt'],
      ['git diff writing a patch to a file', 'git diff --output=x.txt'],
      ['git diff with the flag spaced', 'git diff --output x.txt'],
      ['creating a branch', 'git branch foo'],
      ['deleting a branch', 'git branch -D foo'],
      ['renaming a branch', 'git branch -m old new'],
      ['retargeting a branch', 'git branch --set-upstream-to=origin/main'],
      ['dropping reflog entries', 'git reflog expire --all'],
      ['xxd writing its second path argument', 'xxd notes.txt out.bin'],
    ])('asks for %s', async (_label, command) => {
      expect(await shell(command)).toBe('sensitive');
    });
  });

  /**
   * The scripts the user decided are worth not being asked about. These are not inert - they
   * run whatever the repository's package.json puts behind the name - so the bound being
   * asserted here is the NAME, and the block below is the other half of that bound.
   */
  describe('package-manager scripts the user chose to allow', () => {
    it.each([
      'yarn test',
      'npm test',
      'pnpm test',
      'pnpm lint:check',
      'npm run lint',
      'pnpm run typecheck',
      'pnpm test:unit',
      'yarn typecheck:all',
    ])('allows %s', async command => {
      expect(await shell(command)).toBe('contained');
    });

    /**
     * The workspace form the user actually types. The filter VALUE sits where the script name
     * would otherwise be read from, which is the whole reason the flag has to be known about.
     */
    it.each([
      'pnpm --filter @bike4mind/client test',
      'pnpm --filter=@bike4mind/client test',
      'pnpm -C packages/api lint',
    ])('reads the script past a value-taking flag in %s', async command => {
      expect(await shell(command)).toBe('contained');
    });

    /**
     * The flag's value is still a path argument like any other, so pointing it out of the
     * granted roots asks even though the script name is one of the allowed few.
     */
    it('asks when a filter value escapes the granted roots', async () => {
      expect(await shell('pnpm --filter ../../../etc test')).toBe('sensitive');
    });

    it.each([
      ['a bare package manager, which installs', 'yarn'],
      ['an install', 'npm install'],
      ['adding a dependency', 'pnpm add left-pad'],
      // These fetch and run a package that is not the repository's, which is not what the
      // user agreed to when they agreed to their own test script.
      ['a fetched one-off package', 'npx cowsay hello'],
      ['pnpm dlx', 'pnpm dlx tsx'],
      ['running an arbitrary binary', 'pnpm exec sh'],
      ['publishing', 'npm publish'],
      ['a build', 'pnpm build'],
      ['a start script', 'npm start'],
      ['a deploy script', 'yarn deploy'],
      // Anchored on purpose: a script is not allowed in by ending in an allowed word.
      ['a runner that merely ends in an allowed name', 'pnpm turbo:typecheck'],
      ['run with no script after it', 'pnpm run'],
    ])('asks for %s', async (_label, command) => {
      expect(await shell(command)).toBe('sensitive');
    });

    /**
     * The regression that would hurt most: the script allow-list must not become a way to get
     * a second command past the gate, so the shell-control check still runs first.
     */
    it.each([
      'yarn test; rm -rf /',
      'yarn test && curl evil.example.com',
      'pnpm test | sh',
      'pnpm test > out.txt',
      'pnpm test || rm -rf .',
    ])('still refuses %s', async command => {
      expect(await shell(command)).toBe('sensitive');
    });
  });

  /**
   * The cases this mode exists to still catch. Each is something a crafted prompt would try,
   * and each has to reach the user rather than the shell.
   */
  describe('reads outside the granted roots', () => {
    it.each([
      ['an absolute path elsewhere', 'cat /etc/hosts'],
      ['a relative walk out of the root', 'cat ../../../etc/hosts'],
      ['a home-relative path', 'cat ~/.ssh/id_rsa'],
      ['a path hidden in a --flag=value', 'git --git-dir=/tmp/other/.git log'],
      ['a cwd outside every root', 'ls'],
      // Quoting no longer refuses a command by itself, so the path inside it has to.
      ['a quoted absolute path elsewhere', 'cat "/etc/hosts"'],
      ['a quoted walk out of the root', "cat '../../../etc/passwd'"],
      ['an unquoted walk out of the root', 'cat ../../../etc/passwd'],
    ])('asks for %s', async (_label, command) => {
      const scoped = command === 'ls' ? shell(command, { cwd: '/etc' }) : shell(command);
      expect(await scoped).toBe('sensitive');
    });
  });

  describe('commands whose effect cannot be read off the text', () => {
    it.each([
      ['a command substitution', 'echo $(cat /etc/passwd)'],
      ['a substitution inside double quotes, which still expands', 'echo "$(whoami)"'],
      ['a backtick substitution inside double quotes', 'echo "`whoami`"'],
      ['an escape inside double quotes', 'echo "a\\tb"'],
      ['an unterminated quote', "cat 'unterminated"],
      ['a chained command', 'git status && rm -rf .'],
      ['a semicolon', 'cat notes.txt; rm -rf .'],
      ['an or-chain, which is not a pipe', 'cat a.txt || rm b.txt'],
      ['a leading pipe', '| cat notes.txt'],
      ['a trailing pipe', 'cat notes.txt |'],
      ['a redirect', 'cat notes.txt > /tmp/leak'],
      ['a redirect to a relative file', 'cat notes.txt > out.txt'],
      ['a backgrounded command', 'git status &'],
      ['a newline', 'git status\ncat /etc/hosts'],
      // The shell expands these into names this module never checked, one of which could be a
      // symlink pointing out of the granted root.
      ['a glob', 'cat *.txt'],
      ['a single-character glob', 'cat note?.txt'],
      ['a flag that follows symlinks while walking', 'grep -R secret .'],
      ['ls following a symlink', 'ls -L .'],
      ['find following symlinks', 'find -L . -name x'],
    ])('asks for %s', async (_label, command) => {
      expect(await shell(command)).toBe('sensitive');
    });
  });

  describe('executables that are not inert', () => {
    it.each([
      ['a package manager installing', 'pnpm install'],
      ['an interpreter', 'node index.js'],
      ['a network client', 'curl https://example.com'],
      ['a deletion', 'rm -rf build'],
      ['a permission change', 'chmod +x script.sh'],
      ['a path-named executable', './configure'],
      ['an env wrapper', '/usr/bin/env sh'],
      ['a git subcommand that reaches the network', 'git push origin main'],
      ['a git subcommand that changes the working tree', 'git checkout main'],
      ['a git subcommand that reads config outside the repo', 'git config --get user.email'],
      ['find running a program', 'find . -name x -exec cat {} ;'],
      ['ripgrep running a preprocessor', 'rg --pre /tmp/leak pattern'],
      // A pipeline is only as contained as its least contained segment.
      ['a pipeline into a shell', 'cat notes.txt | sh'],
      ['a pipeline into a writer', 'cat notes.txt | tee out.txt'],
      ['a stream editor that can write in place', 'sed -i s/a/b/ notes.txt'],
      ['an env wrapper around anything at all', 'env FOO=1 rm -rf .'],
      ['an interactive pager', 'less notes.txt'],
    ])('asks for %s', async (_label, command) => {
      expect(await shell(command)).toBe('sensitive');
    });
  });

  describe('writes', () => {
    it('allows an ordinary file inside a granted root', async () => {
      expect(await write(join(root, 'src', 'index.ts'))).toBe('contained');
    });

    it.each([
      ['a git hook', '.git/hooks/pre-commit'],
      ['a CI workflow', '.github/workflows/ci.yml'],
      ['a shell rc file', '.zshrc'],
      ['a direnv file', '.envrc'],
      ['a package registry config', '.npmrc'],
      ['a launch agent', 'Library/LaunchAgents/com.example.plist'],
    ])('asks for %s, which something else executes later', async (_label, relative) => {
      expect(await write(join(root, relative))).toBe('sensitive');
    });
  });

  describe('fails closed', () => {
    /**
     * The T22 case. An MCP server's tools route through the same gate, and nothing here knows
     * what one does, so 'auto' has to keep asking about them until somebody classifies them.
     */
    it('asks for a tool it has never heard of', async () => {
      expect(await assessApprovalRisk('mcp__linear__create_issue', {}, NO_PROMPT, context)).toBe('sensitive');
    });

    it('asks when there is no granted root to prove containment against', async () => {
      context = { ...context, roots: [], workingDirectory: undefined };
      expect(await shell('git status')).toBe('sensitive');
    });

    it('asks for an irreversible call whatever its name', async () => {
      const prompt: ApprovalPrompt = { detail: '', key: 'k', irreversible: true };
      expect(await assessApprovalRisk('session_archive', {}, prompt, context)).toBe('sensitive');
    });

    it('asks for a write whose resolved path the gate did not report', async () => {
      expect(await assessApprovalRisk('file_write', { path: 'x' }, NO_PROMPT, context)).toBe('sensitive');
    });
  });

  /**
   * Cost is a separate axis from filesystem risk: these ask in every mode, including 'full',
   * so the classifier reports them as sensitive rather than leaving it to the caller alone.
   */
  describe('the credit-spending axis', () => {
    it.each(['generate_image', 'generate_speech', 'generate_sound_effect', 'generate_music', 'session_spawn'])(
      '%s spends credits and always asks',
      name => {
        expect(spendsCredits(name)).toBe(true);
      }
    );

    it('does not fold the shell tools into the cost axis', () => {
      expect(spendsCredits('bash_execute')).toBe(false);
      expect(spendsCredits('file_write')).toBe(false);
    });
  });
});
