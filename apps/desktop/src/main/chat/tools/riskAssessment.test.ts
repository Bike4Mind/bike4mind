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
    ])('allows %s', async command => {
      expect(await shell(command.replace('{ROOT}', root))).toBe('contained');
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
    ])('asks for %s', async (_label, command) => {
      const scoped = command === 'ls' ? shell(command, { cwd: '/etc' }) : shell(command);
      expect(await scoped).toBe('sensitive');
    });
  });

  describe('commands whose effect cannot be read off the text', () => {
    it.each([
      ['a pipe', 'cat notes.txt | sh'],
      ['a command substitution', 'echo $(cat /etc/passwd)'],
      ['a chained command', 'git status && rm -rf .'],
      ['a redirect', 'cat notes.txt > /tmp/leak'],
      ['a backgrounded command', 'git status &'],
      ['quoting', 'cat "/etc/hosts"'],
      ['a newline', 'git status\ncat /etc/hosts'],
    ])('asks for %s', async (_label, command) => {
      expect(await shell(command)).toBe('sensitive');
    });
  });

  describe('executables that are not inert', () => {
    it.each([
      ['a package manager', 'pnpm install'],
      ['a test runner that executes repository code', 'pnpm test'],
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
