import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PARENT_WATCH_FD, parentWatchStdioIndex, wrapWithParentWatchdog } from './backgroundScript';

describe('wrapWithParentWatchdog', () => {
  it('takes the watch pipe on stdin on Windows and on fd 3 elsewhere', () => {
    expect(parentWatchStdioIndex('win32')).toBe(0);
    expect(parentWatchStdioIndex('darwin')).toBe(PARENT_WATCH_FD);
    expect(wrapWithParentWatchdog('true', 'win32').split('\n')[0]).toBe(`exec ${PARENT_WATCH_FD}<&0 0</dev/null`);
    expect(wrapWithParentWatchdog('true', 'linux')).not.toContain('<&0');
  });

  it.runIf(process.platform !== 'win32')(
    'the Windows form stops the command when stdin closes, and keeps stdin from the command',
    async () => {
      const child = spawn('bash', ['-c', wrapWithParentWatchdog('read -r line || echo no-stdin; sleep 30', 'win32')], {
        detached: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      try {
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
        const ended = new Promise<NodeJS.Signals | null>(resolve =>
          child.on('exit', (_code, signal) => resolve(signal))
        );

        await new Promise(resolve => setTimeout(resolve, 300));
        expect(output).toBe('no-stdin\n');

        child.stdin.end();
        expect(await ended).toBe('SIGTERM');
      } finally {
        try {
          process.kill(-(child.pid as number), 'SIGKILL');
        } catch {
          // The group already ended.
        }
      }
    }
  );
});
