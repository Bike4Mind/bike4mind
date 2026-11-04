import { describe, expect, it, vi } from 'vitest';
import { compileRule, parseRule, PermissionRuleSet } from '../permissions/rules';
import { permissionSubject } from '../permissions/subject';
import type { ShellScan } from './shellScan';
import { shellApproval, UNREAD_WSL_COMMAND } from './shellTools';
import type { ToolContext } from './types';

const DEBIAN = '\\\\wsl.localhost\\Debian\\home\\me';

const scanned = vi.hoisted(() => ({ ungranted: [] as string[], unreadable: false }));

vi.mock('node:path', async importOriginal => {
  const { win32 } = await importOriginal<typeof import('node:path')>();
  return { ...win32, default: win32 };
});
vi.mock('../../wsl/wslPath', async importOriginal => {
  const actual = await importOriginal<typeof import('../../wsl/wslPath')>();
  return { ...actual, wslLocation: (directory: string) => actual.parseWslPath(directory) };
});
vi.mock('./shellScan', async importOriginal => ({
  ...(await importOriginal<typeof import('./shellScan')>()),
  scanShell: async (): Promise<ShellScan | null> =>
    scanned.unreadable
      ? null
      : {
          commands: [{ text: 'ls', always: 'ls *', coverable: true, words: 'ls' }],
          paths: [],
          directories: [],
          ungranted: scanned.ungranted,
          envFiles: [],
          outbound: [],
          sends: [],
          contained: true,
          readOnly: false,
          writes: [],
          writtenTrees: [],
        },
}));

const context: Pick<ToolContext, 'roots' | 'signal' | 'protectedPaths'> = {
  roots: ['C:\\repo'],
  signal: new AbortController().signal,
  protectedPaths: [],
};

describe('a shell command that reaches a WSL distro no root is in', () => {
  it('asks in every mode but full, names the path, and offers no folder to remember', async () => {
    scanned.ungranted = [DEBIAN];

    const prompt = await shellApproval('bash_execute', { command: `ls '${DEBIAN}'` }, context);

    expect(prompt.askInAuto).toBe(true);
    expect(prompt.detail).toContain(`Reaches ${DEBIAN}, in a WSL distro this project has no folder in.`);
    expect(prompt.always?.directories).toEqual([]);
    expect(prompt.always?.ungranted).toEqual([DEBIAN]);
  });

  it('names a Linux name kept behind a NUL with that character shown, and keeps the path as scanned', async () => {
    const kept = '\\\\wsl.localhost\\Debian\\home\\x\0\u{f05c}';
    scanned.ungranted = [kept];

    const prompt = await shellApproval('bash_execute', { command: 'ls' }, context);

    expect(prompt.detail).toContain('Reaches \\\\wsl.localhost\\Debian\\home\\x<U+F05C>, in a WSL distro');
    expect(prompt.always?.ungranted).toEqual([kept]);
  });

  it('treats a working directory in such a distro as unreachable, not as a folder to remember', async () => {
    scanned.ungranted = [];

    const prompt = await shellApproval('bash_execute', { command: 'ls', cwd: DEBIAN }, context);

    expect(prompt.askInAuto).toBe(true);
    expect(prompt.always?.directories).toEqual([]);
    expect(prompt.always?.ungranted).toEqual([DEBIAN]);
  });

  it('is not allowed by a rule that names the command', async () => {
    const parsed = parseRule('Bash(ls:*)', { native: true });
    if (!parsed.ok) throw new Error(parsed.reason);
    const rule = compileRule(
      parsed.rule,
      'allow',
      { id: 'test', label: 'Test' },
      { home: 'C:\\Users\\me', root: 'C:\\repo', cwd: 'C:\\repo' }
    );
    if (!rule) throw new Error('Expected the allow rule to compile');
    const rules = new PermissionRuleSet([rule]);
    const call = { name: 'bash_execute', input: { command: `ls '${DEBIAN}'` } };
    const place = { roots: context.roots, workingDirectory: 'C:\\repo' };

    scanned.ungranted = [];
    const local = await shellApproval('bash_execute', { command: 'ls' }, context);
    expect(rules.evaluate(permissionSubject(call, local, place)).decision).toBe('allow');

    scanned.ungranted = [DEBIAN];
    const reaching = await shellApproval('bash_execute', call.input, context);
    expect(rules.evaluate(permissionSubject(call, reaching, place)).decision).toBeNull();
  });

  it('leaves a command that reaches no such distro to the mode', async () => {
    scanned.ungranted = [];

    const prompt = await shellApproval('bash_execute', { command: 'ls' }, context);

    expect(prompt.askInAuto).toBeUndefined();
    expect(prompt.always?.ungranted).toEqual([]);
  });
});

describe('a shell command the scan could not read', () => {
  const UBUNTU = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';

  it('in a WSL project, asks each time: no rule or saved answer covers it', async () => {
    scanned.unreadable = true;
    const wslContext = { ...context, roots: [UBUNTU] };
    const call = { name: 'bash_execute', input: { command: 'cat ~/x //wsl.localhost/Debian/etc/shadow' } };

    const prompt = await shellApproval('bash_execute', call.input, wslContext);

    expect(prompt.askInAuto).toBe(true);
    expect(prompt.always?.ungranted).toEqual([UNREAD_WSL_COMMAND]);
    expect(prompt.detail).toContain('Could not read this command');

    const parsed = parseRule(`Bash(${call.input.command})`, { native: true });
    if (!parsed.ok) throw new Error(parsed.reason);
    const rule = compileRule(
      parsed.rule,
      'allow',
      { id: 'test', label: 'Test' },
      { home: 'C:\\Users\\me', root: UBUNTU, cwd: UBUNTU }
    );
    if (!rule) throw new Error('Expected the allow rule to compile');
    const subject = permissionSubject(call, prompt, { roots: wslContext.roots, workingDirectory: UBUNTU });
    expect(new PermissionRuleSet([rule]).evaluate(subject).decision).toBeNull();
    scanned.unreadable = false;
  });

  it('in a Windows-drive project that names no distro, stays rememberable as before', async () => {
    scanned.unreadable = true;

    const prompt = await shellApproval('bash_execute', { command: 'cat ~/x' }, context);

    expect(prompt.askInAuto).toBe(true);
    expect(prompt.always).toBeUndefined();
    scanned.unreadable = false;
  });
});
