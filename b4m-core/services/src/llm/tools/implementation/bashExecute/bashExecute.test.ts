import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { ShellSessionManager } from './ShellSessionManager';
import { executeBackgroundSession, executeBashCommand, formatSessionResult } from './index';

// The foreground path calls the module-level child_process.spawn directly (session
// mode uses an injected spawnFn instead), so mock spawn to drive it. Session-mode
// tests inject their own spawnFn and never hit this mock.
vi.mock('child_process', async importActual => {
  const actual = await importActual<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});
const mockSpawn = vi.mocked(spawn);

/** Controllable ChildProcess stand-in. */
class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(public pid = 4242) {
    super();
  }
  emitStdout(chunk: string) {
    this.stdout.emit('data', Buffer.from(chunk));
  }
  close(code: number | null) {
    this.exitCode = code;
    this.emit('close', code);
  }
}

function managerWith(children: MockChild[]) {
  let i = 0;
  const spawnFn = (() => children[i++]) as unknown as typeof spawn;
  return new ShellSessionManager({ spawnFn });
}

describe('bash_execute session mode', () => {
  it('returns full output when the session finishes within the wait window', async () => {
    const child = new MockChild();
    const manager = managerWith([child]);

    const promise = executeBackgroundSession({ command: 'echo hi', run_in_background: true }, 1000, manager);
    // spawn + subscribe have run synchronously; drive the child on the next tick.
    await Promise.resolve();
    child.emitStdout('hi\n');
    child.close(0);

    const result = await promise;
    expect(result).toContain('finished: exit 0');
    expect(result).toContain('hi');
    expect(result).not.toContain('still running');
  });

  it('returns a pollable session id when still running after the wait window', async () => {
    const child = new MockChild();
    const manager = managerWith([child]);

    const result = await executeBackgroundSession({ command: 'sleep 100', yield_time_ms: 5 }, 5, manager);
    expect(result).toContain('still running');
    expect(result).toMatch(/session_id: "sh-/);
    // The child is still alive and tracked.
    expect(manager.list()[0].status).toBe('running');
  });

  it('blocks dangerous commands before spawning in session mode', async () => {
    const manager = managerWith([]); // spawn must never be called
    const result = await executeBackgroundSession({ command: 'sudo rm -rf /', run_in_background: true }, 1000, manager);
    expect(result).toContain('BLOCKED');
    expect(manager.size).toBe(0);
  });

  it('rejects an empty command without spawning', async () => {
    const manager = managerWith([]);
    const result = await executeBackgroundSession({ command: '   ', run_in_background: true }, 1000, manager);
    expect(result).toContain('BLOCKED: Empty command');
    expect(manager.size).toBe(0);
  });

  it('surfaces the running-session cap as a recoverable message, not a throw', async () => {
    const manager = new ShellSessionManager({
      spawnFn: (() => new MockChild()) as unknown as typeof spawn,
      maxRunning: 1,
    });
    await executeBackgroundSession({ command: 'sleep 100', run_in_background: true }, 5, manager);
    const result = await executeBackgroundSession({ command: 'sleep 100', run_in_background: true }, 5, manager);
    expect(result).toContain('[cannot start background session]');
    expect(result).toContain('kill_background_shell');
  });
});

describe('bash_execute foreground mode', () => {
  it('reassembles a multibyte char split across two stdout chunks', async () => {
    const child = new MockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    // spawn + handlers attach synchronously inside the Promise executor.
    const promise = executeBashCommand({ command: 'printf smiley' });

    // '😀' (U+1F600) is F0 9F 98 80; split mid-codepoint across two data events.
    const bytes = Buffer.from('😀', 'utf8');
    child.stdout.emit('data', bytes.subarray(0, 2));
    child.stdout.emit('data', bytes.subarray(2));
    child.close(0);

    const result = await promise;
    expect(result.stdout).toBe('😀');
    expect(result.stdout).not.toContain('�');
    expect(result.exitCode).toBe(0);
  });

  it('flushes an incomplete trailing byte at close as a single replacement char', async () => {
    const child = new MockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeBashCommand({ command: 'printf partial' });

    // First byte of 'é' (0xC3) with no continuation; decoder.end() in the close
    // handler flushes it as one U+FFFD.
    child.stdout.emit('data', Buffer.from([0xc3]));
    child.close(0);

    const result = await promise;
    expect(result.stdout).toBe('�');
  });
});

describe('formatSessionResult', () => {
  const base = {
    id: 'sh-1',
    command: 'echo hi',
    cwd: '/tmp',
    startTime: 0,
    totalOutputChars: 3,
  };

  it('formats a finished session with its exit code and output', () => {
    const out = formatSessionResult({ ...base, status: 'exited', exitCode: 0, endTime: 1 }, 'hi\n');
    expect(out).toContain('[session sh-1 finished: exit 0]');
    expect(out).toContain('hi');
  });

  it('formats a still-running session with the polling contract', () => {
    const out = formatSessionResult({ ...base, status: 'running', exitCode: null }, 'booting...');
    expect(out).toContain('background session started: sh-1');
    expect(out).toContain('check_shell_output');
    expect(out).toContain('booting...');
  });

  it('reports the status word when killed with no exit code', () => {
    const out = formatSessionResult({ ...base, status: 'killed', exitCode: null, endTime: 1 }, '');
    expect(out).toContain('finished: killed');
    expect(out).toContain('(no output)');
  });
});
