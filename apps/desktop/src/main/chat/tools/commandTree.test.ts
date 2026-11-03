import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMAND_TAG_ENV, WINDOWS_TREE_SCRIPT, commandExit } from './commandTree';

describe('commandExit', () => {
  it('reads a Git Bash signal exit back as the signal on Windows', () => {
    expect(commandExit(15 * 256, null, 'win32')).toEqual({ code: null, signal: 'SIGTERM' });
    expect(commandExit(9 * 256, null, 'win32')).toEqual({ code: null, signal: 'SIGKILL' });
  });

  it('leaves ordinary exits, unknown numbers and other platforms alone', () => {
    expect(commandExit(3, null, 'win32')).toEqual({ code: 3, signal: null });
    expect(commandExit(200 * 256, null, 'win32')).toEqual({ code: 200 * 256, signal: null });
    expect(commandExit(15 * 256, null, 'linux')).toEqual({ code: 15 * 256, signal: null });
    expect(commandExit(null, 'SIGTERM', 'darwin')).toEqual({ code: null, signal: 'SIGTERM' });
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
    const first = sleeper('tag-one');
    const second = sleeper('tag-two');
    const untagged = sleeper();
    const other = sleeper('tag-other');
    await new Promise(resolve => setTimeout(resolve, 200));

    const run = spawnSync('bash', ['-c', WINDOWS_TREE_SCRIPT, 'b4m-signal', 'TERM', '', 'tag-one', 'tag-two'], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);

    expect(await first.ended).toBe('SIGTERM');
    expect(await second.ended).toBe('SIGTERM');
    expect(untagged.child.exitCode).toBeNull();
    expect(untagged.child.signalCode).toBeNull();
    expect(other.child.signalCode).toBeNull();
  });
});
