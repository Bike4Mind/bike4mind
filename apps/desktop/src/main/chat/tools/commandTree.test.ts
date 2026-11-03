import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMAND_TAG_ENV, WINDOWS_TREE_SCRIPT, commandExit, signalCommandTree } from './commandTree';

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

  it('leaves ordinary exits, unknown numbers and other platforms alone', () => {
    expect(commandExit(3, null, undefined, 'win32')).toEqual({ code: 3, signal: null });
    expect(commandExit(29 * 256, null, undefined, 'win32')).toEqual({ code: 29 * 256, signal: null });
    expect(commandExit(200 * 256, null, undefined, 'win32')).toEqual({ code: 200 * 256, signal: null });
    expect(commandExit(15 * 256, null, undefined, 'linux')).toEqual({ code: 15 * 256, signal: null });
    expect(commandExit(null, 'SIGTERM', undefined, 'darwin')).toEqual({ code: null, signal: 'SIGTERM' });
  });

  it('reports SIGKILL for a Windows command this side killed, whatever exit code it left', async () => {
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
    expect(commandExit(1, null, spawn('true'), 'win32')).toEqual({ code: 1, signal: null });
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

    const run = spawnSync('bash', ['-c', WINDOWS_TREE_SCRIPT, 'b4m-signal', 'TERM', one, two], { encoding: 'utf8' });
    expect(run.status).toBe(0);

    expect(await first.ended).toBe('SIGTERM');
    expect(await second.ended).toBe('SIGTERM');
    expect(untagged.child.exitCode).toBeNull();
    expect(untagged.child.signalCode).toBeNull();
    expect(elsewhere.child.signalCode).toBeNull();
  });
});
