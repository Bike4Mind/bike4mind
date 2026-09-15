import { describe, it, expect } from 'vitest';
import { runShellCommand } from './shellRunner';

describe('runShellCommand', () => {
  it('captures stdout and exit code', async () => {
    const result = await runShellCommand({ command: 'printf hello', cwd: process.cwd(), timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
  });

  it('pipes stdin to a reading command', async () => {
    const result = await runShellCommand({ command: 'cat', cwd: process.cwd(), timeoutMs: 5000, stdin: 'piped' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('piped');
  });

  it('reports a non-zero exit code', async () => {
    const result = await runShellCommand({ command: 'exit 3', cwd: process.cwd(), timeoutMs: 5000 });
    expect(result.exitCode).toBe(3);
  });

  // A child that never reads stdin (e.g. `rm -f` clear hooks) can close its read
  // end and exit before we finish writing a large payload. The pending write then
  // rejects with EPIPE asynchronously; without an error handler on child.stdin,
  // Node escalates it to an unhandled exception that crashes the vitest worker. A
  // payload larger than the OS pipe buffer (64 KiB) plus a fast-exiting non-reading
  // command reliably provokes the race. Fan-out is kept low to avoid amplifying CPU
  // contention on the `rest` shard. All calls must resolve cleanly without an
  // unhandled error.
  it('does not crash on EPIPE when the child never reads a large stdin payload', async () => {
    const bigStdin = 'x'.repeat(256 * 1024);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        runShellCommand({ command: 'true', cwd: process.cwd(), timeoutMs: 5000, stdin: bigStdin })
      )
    );
    expect(results).toHaveLength(10);
    expect(results.every(r => r.exitCode === 0)).toBe(true);
  });
});
