import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMAND_TAG_ENV,
  WINDOWS_TREE_SCRIPT,
  commandExit,
  signalCommandTree,
  windowsSignalCommands,
  type CommandTree,
} from './commandTree';

describe('commandExit', () => {
  it('reads a Git Bash signal exit back as the signal on Windows, by MSYS signal number', () => {
    expect(commandExit(15 * 256, null, undefined, 'win32')).toEqual({ code: null, signal: 'SIGTERM' });
    expect(commandExit(9 * 256, null, undefined, 'win32')).toEqual({ code: null, signal: 'SIGKILL' });
    expect(commandExit(13 * 256, null, undefined, 'win32')).toEqual({ code: null, signal: 'SIGPIPE' });
    expect(commandExit(6 * 256, null, undefined, 'win32')).toEqual({ code: null, signal: 'SIGABRT' });
    expect(commandExit(21 * 256, null, undefined, 'win32')).toEqual({ code: null, signal: 'SIGTTIN' });
    expect(commandExit(22 * 256, null, undefined, 'win32')).toEqual({ code: null, signal: 'SIGTTOU' });
    expect(commandExit(30 * 256, null, undefined, 'win32')).toEqual({ code: null, signal: 'SIGUSR1' });
  });

  it('reads a signal death that dumped core, with 0x80 set beside the signal number', () => {
    expect(commandExit(0x8b00, null, undefined, 'win32')).toEqual({ code: null, signal: 'SIGSEGV' });
    expect(commandExit(0x8600, null, undefined, 'win32')).toEqual({ code: null, signal: 'SIGABRT' });
    expect(commandExit(0x10b00, null, undefined, 'win32')).toEqual({ code: 0x10b00, signal: null });
    expect(commandExit(0x8b01, null, undefined, 'win32')).toEqual({ code: 0x8b01, signal: null });
  });

  it('leaves ordinary exits, unknown numbers and other platforms alone', () => {
    expect(commandExit(3, null, undefined, 'win32')).toEqual({ code: 3, signal: null });
    expect(commandExit(29 * 256, null, undefined, 'win32')).toEqual({ code: 29 * 256, signal: null });
    expect(commandExit(200 * 256, null, undefined, 'win32')).toEqual({ code: 200 * 256, signal: null });
    expect(commandExit(15 * 256, null, undefined, 'linux')).toEqual({ code: 15 * 256, signal: null });
    expect(commandExit(null, 'SIGTERM', undefined, 'darwin')).toEqual({ code: null, signal: 'SIGTERM' });
  });

  it.runIf(process.platform !== 'win32')('reports SIGKILL for a Windows command this side killed', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const exited = new Promise(resolve => child.on('exit', resolve));
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const launch = { executable: 'true', args: [], processTag: randomUUID(), cleanup: async () => undefined };
      signalCommandTree({ pid: child.pid as number, child, launch }, 'SIGKILL');
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
    await exited;
    expect(commandExit(1, null, child, 'win32')).toEqual({ code: null, signal: 'SIGKILL' });
    const other = spawn('true');
    await new Promise(resolve => other.on('exit', resolve));
    expect(commandExit(1, null, other, 'win32')).toEqual({ code: 1, signal: null });
  });

  it('reads wsl.exe exit N or 128 + N back as signal N only for a WSL command this side sent N', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const stopped = {} as ChildProcess;
    const other = {} as ChildProcess;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const launch = {
        executable: 'wsl.exe',
        args: [],
        processTag: randomUUID(),
        wslDistro: `b4m-missing-${randomUUID()}`,
        cleanup: async () => undefined,
      };
      signalCommandTree({ pid: 0, child: stopped, launch }, 'SIGTERM');
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
    expect(commandExit(15, null, stopped, 'win32')).toEqual({ code: null, signal: 'SIGTERM' });
    expect(commandExit(143, null, stopped, 'win32')).toEqual({ code: null, signal: 'SIGTERM' });
    expect(commandExit(1, null, stopped, 'win32')).toEqual({ code: 1, signal: null });
    expect(commandExit(15, null, other, 'win32')).toEqual({ code: 15, signal: null });
    expect(commandExit(143, null, other, 'win32')).toEqual({ code: 143, signal: null });
  });
});

describe('windowsSignalCommands', () => {
  const cleanup = async () => undefined;
  const child = {} as ChildProcess;
  const native = (pid: number, tag: string): CommandTree => ({
    pid,
    child,
    launch: { executable: 'C:\\Git\\bin\\bash.exe', args: [], processTag: tag, cleanup },
  });
  const wsl = (pid: number, tag: string, distro: string): CommandTree => ({
    pid,
    child,
    launch: { executable: 'wsl.exe', args: [], processTag: tag, wslDistro: distro, cleanup },
  });

  it('sweeps Git Bash once for every native tree, by tag alone, always forced, with taskkill by absolute path', () => {
    const [sweep, ...rest] = windowsSignalCommands([native(10, 'a'), native(11, 'b')], 'SIGTERM');
    expect(rest).toEqual([]);
    expect(sweep?.file).toBe('C:\\Git\\bin\\bash.exe');
    expect(sweep?.args.slice(0, 3)).toEqual(['-c', WINDOWS_TREE_SCRIPT, 'b4m-signal']);
    expect(sweep?.args[3]).toMatch(/^[A-Z]:\\.*\\System32\\taskkill\.exe$/i);
    expect(sweep?.args.slice(4)).toEqual(['KILL', 'a', 'b']);
  });

  it('sweeps each distro inside Linux with the signal as sent, and names no pid', () => {
    const commands = windowsSignalCommands(
      [wsl(20, 'a', 'Ubuntu'), wsl(21, 'b', 'Ubuntu'), wsl(22, 'c', 'Debian'), native(23, 'd')],
      'SIGTERM'
    );
    expect(commands[0]?.file).toBe('C:\\Git\\bin\\bash.exe');
    expect(commands.slice(1).map(command => command.file)).toEqual([
      expect.stringMatching(/^[A-Z]:\\.*\\System32\\wsl\.exe$/i),
      expect.stringMatching(/^[A-Z]:\\.*\\System32\\wsl\.exe$/i),
    ]);
    expect(commands[1]?.args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--exec', 'bash', '-c']);
    expect(commands[1]?.args.slice(6)).toEqual(['b4m-signal', '', 'TERM', 'a', 'b']);
    expect(commands[2]?.args.slice(6)).toEqual(['b4m-signal', '', 'TERM', 'c']);
    expect(commands.flatMap(command => command.args).some(arg => /^2\d$/.test(arg))).toBe(false);
  });
});

// The Windows script reads /proc/<pid>/environ, which Linux has too, so its tag matching runs here.
describe.runIf(process.platform === 'linux')('WINDOWS_TREE_SCRIPT', () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  const sleeper = (tag?: string): { child: ChildProcess; ended: Promise<NodeJS.Signals | null> } => {
    const env = tag ? { ...process.env, [COMMAND_TAG_ENV]: tag } : { ...process.env };
    const child = spawn('sleep', ['30'], { env, stdio: 'ignore' });
    children.push(child);
    return { child, ended: new Promise(resolve => child.on('exit', (_code, signal) => resolve(signal))) };
  };

  it('signals every process carrying one of the tags and nothing else', async () => {
    const [one, two, other] = [randomUUID(), randomUUID(), randomUUID()];
    const first = sleeper(one);
    const second = sleeper(two);
    const untagged = sleeper();
    const elsewhere = sleeper(other);
    await new Promise(resolve => setTimeout(resolve, 200));

    const run = spawnSync('bash', ['-c', WINDOWS_TREE_SCRIPT, 'b4m-signal', '', 'TERM', one, two], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);

    expect(await first.ended).toBe('SIGTERM');
    expect(await second.ended).toBe('SIGTERM');
    expect(untagged.child.exitCode).toBeNull();
    expect(untagged.child.signalCode).toBeNull();
    expect(elsewhere.child.signalCode).toBeNull();
  });

  it('kills tagged processes with SIGKILL where there is no taskkill, as in a WSL distro', async () => {
    const tag = randomUUID();
    const tagged = sleeper(tag);
    await new Promise(resolve => setTimeout(resolve, 200));
    spawnSync('bash', ['-c', WINDOWS_TREE_SCRIPT, 'b4m-signal', '', 'KILL', tag]);
    expect(await tagged.ended).toBe('SIGKILL');
  });
});

// Linux has no /proc/<pid>/winpid, so this runs the script against a stand-in for the MSYS /proc.
describe.runIf(process.platform !== 'win32')('WINDOWS_TREE_SCRIPT given taskkill', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'b4m-tree-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const fakeProcess = async (pid: number, env: string[], winpid: number): Promise<void> => {
    await mkdir(join(root, 'proc', String(pid)), { recursive: true });
    await writeFile(join(root, 'proc', String(pid), 'environ'), env.map(entry => `${entry}\0`).join(''));
    await writeFile(join(root, 'proc', String(pid), 'winpid'), `${winpid}\n`);
  };

  it('force-ends the Windows tree of each tagged process by its winpid', async () => {
    const [one, two] = [randomUUID(), randomUUID()];
    await fakeProcess(100, ['PATH=/usr/bin', `${COMMAND_TAG_ENV}=${one}`], 4100);
    await fakeProcess(200, ['PATH=/usr/bin'], 4200);
    await fakeProcess(300, [`X_${COMMAND_TAG_ENV}=${one}`, `${COMMAND_TAG_ENV}=${randomUUID()}`], 4300);
    await fakeProcess(400, [`${COMMAND_TAG_ENV}=${two}`], 4400);
    const log = join(root, 'taskkill.log');
    const taskkill = join(root, 'taskkill');
    await writeFile(taskkill, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`, { mode: 0o755 });

    const script = WINDOWS_TREE_SCRIPT.replaceAll('/proc/', `${root}/proc/`);
    const run = spawnSync('bash', ['-c', script, 'b4m-signal', taskkill, 'KILL', one, two], { encoding: 'utf8' });

    expect(run.status).toBe(0);
    expect(await readFile(log, 'utf8')).toBe('//F //T //PID 4100\n//F //T //PID 4400\n');
  });
});
