import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  kill(): boolean;
  unref(): void;
}

const spawned: { file: string; args: string[]; child: FakeChild }[] = [];

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (file: string, args: string[]) => {
    const child: FakeChild = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill: () => true,
      unref: () => undefined,
    });
    spawned.push({ file, args, child });
    return child;
  },
}));

const { wslRealpath, wslUserEnvironment } = await import('./wslPath');

const WSL_EXE = /^[A-Z]:\\.*\\System32\\wsl\.exe$/i;
const ANSWER = '__B4M_ENV__/usr/bin__B4M_ENV__/home/me__B4M_ENV__';

function lastSpawn(): { file: string; args: string[]; child: FakeChild } {
  const last = spawned.at(-1);
  if (!last) throw new Error('nothing spawned');
  return last;
}

describe('wsl.exe spawns', () => {
  it('starts the login shell probe from the System32 wsl.exe', async () => {
    const found = wslUserEnvironment(`b4m-${randomUUID()}`);
    const probe = lastSpawn();
    expect(probe.file).toMatch(WSL_EXE);
    probe.child.stdout.write(ANSWER);
    probe.child.emit('close', 0);
    expect(await found).toEqual({ path: '/usr/bin', home: '/home/me' });
  });

  it('starts the realpath session from the System32 wsl.exe', async () => {
    const answer = wslRealpath(`b4m-${randomUUID()}`, '/home/me/link');
    const session = lastSpawn();
    expect(session.file).toMatch(WSL_EXE);
    session.child.stdout.write('/data/me\0');
    expect(await answer).toBe('/data/me');
  });
});
