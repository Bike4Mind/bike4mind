import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn: spawnMock }));

import { recentChangesTool } from './index';

function fakeProc(stdout: string) {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => {
    proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', 0);
  });
  return proc;
}

describe('recent_changes git invocation', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeProc(''));
  });

  it('passes the hardening config flags on every git call', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc('src/example.ts\n'))
      .mockImplementationOnce(() => fakeProc(' M src/example.ts\n'))
      .mockImplementationOnce(() => fakeProc('2\t1\tsrc/example.ts\n'));
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const tool = recentChangesTool.implementation({ logger } as never);
    const result = await tool.toolFn({ include_stats: true, path: 'src', since: '2 days ago' });

    const hardeningArgs = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
    const commands = [
      ['log', '--since=2 days ago', '--name-only', '--pretty=format:', '--', 'src'],
      ['status', '--porcelain', '--', 'src'],
      ['log', '--since=2 days ago', '--numstat', '--pretty=format:', '--', 'src'],
    ];
    expect(spawnMock).toHaveBeenCalledTimes(commands.length);
    for (const [index, command] of commands.entries()) {
      expect(spawnMock).toHaveBeenNthCalledWith(index + 1, 'git', [...hardeningArgs, ...command], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    expect(result).toContain('Unstaged (1):');
    expect(result).toContain('src/example.ts (1 commits) (+2/-1)');
  });
});
