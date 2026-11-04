import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => [] as string[][]);

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (_file: string, args: string[]) => {
    spawned.push(args);
    const stdin = new PassThrough();
    stdin.on('data', (chunk: Buffer) => child.stdout.write(chunk.toString('utf8')));
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout: new PassThrough(),
      kill: () => true,
      unref: () => undefined,
    });
    return child;
  },
}));

const { wslRealpath } = await import('./wslPath');

describe('the realpath session of a distro', () => {
  it('is shared by every spelling of the distro name', async () => {
    expect(await wslRealpath('Arch', '/home/me/a')).toBe('/home/me/a');
    expect(await wslRealpath('ARCH', '/home/me/b')).toBe('/home/me/b');
    expect(await wslRealpath('arch', '/home/me/c')).toBe('/home/me/c');

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.slice(0, 2)).toEqual(['-d', 'Arch']);
  });
});
