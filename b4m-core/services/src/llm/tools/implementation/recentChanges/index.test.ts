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
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const tool = recentChangesTool.implementation({ logger } as never);
    await tool.toolFn({ include_stats: true });

    expect(spawnMock).toHaveBeenCalled();
    const subcommands = new Set<string>();
    for (const [bin, args] of spawnMock.mock.calls as [string, string[]][]) {
      expect(bin).toBe('git');
      expect(args.slice(0, 4)).toEqual(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']);
      subcommands.add(args[4]);
    }
    expect(subcommands.has('status')).toBe(true);
    expect(subcommands.has('log')).toBe(true);
  });
});
