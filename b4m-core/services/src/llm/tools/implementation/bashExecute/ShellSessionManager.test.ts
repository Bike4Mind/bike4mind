import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { spawn } from 'child_process';
import { ShellSessionManager, type ShellSession } from './ShellSessionManager';

/** Minimal ChildProcess stand-in we can drive from tests. */
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
  emitStderr(chunk: string) {
    this.stderr.emit('data', Buffer.from(chunk));
  }
  close(code: number | null) {
    this.exitCode = code;
    this.emit('close', code);
  }
}

/** Builds a manager whose spawn returns caller-controlled mock children. */
function buildManager(
  opts: {
    children?: MockChild[];
    now?: () => number;
    maxOutputChars?: number;
    maxSessions?: number;
    maxRunning?: number;
    retentionMs?: number;
  } = {}
) {
  const children: MockChild[] = opts.children ?? [];
  let nextIndex = 0;
  const spawnFn = ((..._args: unknown[]) => {
    const child = children[nextIndex] ?? new MockChild(4000 + nextIndex);
    if (!children[nextIndex]) children[nextIndex] = child;
    nextIndex++;
    return child;
  }) as unknown as typeof spawn;

  const manager = new ShellSessionManager({
    spawnFn,
    now: opts.now,
    maxOutputChars: opts.maxOutputChars,
    maxSessions: opts.maxSessions,
    maxRunning: opts.maxRunning,
    retentionMs: opts.retentionMs,
  });
  return { manager, children };
}

const ENV = process.env;

describe('ShellSessionManager', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
    vi.useRealTimers();
  });

  it('spawns a running session and lists it', () => {
    const { manager } = buildManager({ children: [new MockChild(4242)] });
    const session = manager.spawn('sleep 1', '/tmp', ENV);

    expect(session.status).toBe('running');
    expect(session.pid).toBe(4242);
    expect(session.exitCode).toBeNull();
    expect(manager.list()).toHaveLength(1);
    expect(manager.get(session.id)?.command).toBe('sleep 1');
  });

  it('buffers output and reads it incrementally by offset', () => {
    const child = new MockChild();
    const { manager } = buildManager({ children: [child] });
    const { id } = manager.spawn('echo', '/tmp', ENV);

    child.emitStdout('hello ');
    const first = manager.getOutput(id);
    expect(first?.output).toBe('hello ');
    expect(first?.truncated).toBe(false);

    child.emitStderr('world');
    const second = manager.getOutput(id, first!.offset);
    expect(second?.output).toBe('world');
    expect(second?.offset).toBe('hello world'.length);
  });

  it('drops old output past the buffer cap and flags truncation', () => {
    const child = new MockChild();
    const { manager } = buildManager({ children: [child], maxOutputChars: 10 });
    const { id } = manager.spawn('yes', '/tmp', ENV);

    child.emitStdout('0123456789ABCDE'); // 15 chars, cap 10
    const slice = manager.getOutput(id, 0);
    expect(slice?.output).toBe('56789ABCDE'); // last 10 retained
    expect(slice?.truncated).toBe(true);
    expect(slice?.offset).toBe(15);
  });

  it('marks exited and records exit code + endTime on close', () => {
    const child = new MockChild();
    let clock = 1000;
    const { manager } = buildManager({ children: [child], now: () => clock });
    const { id } = manager.spawn('true', '/tmp', ENV);

    clock = 1500;
    child.close(0);

    const session = manager.get(id)!;
    expect(session.status).toBe('exited');
    expect(session.exitCode).toBe(0);
    expect(session.endTime).toBe(1500);
  });

  it('notifies subscribers on create and status change', () => {
    const child = new MockChild();
    const { manager } = buildManager({ children: [child] });
    const events: ShellSession[] = [];
    manager.subscribe(s => events.push(s));

    const { id } = manager.spawn('true', '/tmp', ENV);
    child.close(0);

    expect(events.map(e => e.status)).toEqual(['running', 'exited']);
    expect(events.every(e => e.id === id)).toBe(true);
  });

  it('unsubscribe stops further notifications', () => {
    const child = new MockChild();
    const { manager } = buildManager({ children: [child] });
    const events: ShellSession[] = [];
    const unsub = manager.subscribe(s => events.push(s));

    manager.spawn('true', '/tmp', ENV);
    unsub();
    child.close(0);

    expect(events).toHaveLength(1); // only the create event
  });

  it('writes stdin to a running child', () => {
    const child = new MockChild();
    const { manager } = buildManager({ children: [child] });
    const { id } = manager.spawn('cat', '/tmp', ENV);

    expect(manager.writeStdin(id, 'input\n')).toBe(true);
    expect(child.stdin.write).toHaveBeenCalledWith('input\n');
  });

  it('treats \\x03 as an interrupt (SIGINT to the group)', () => {
    const child = new MockChild(999);
    const { manager } = buildManager({ children: [child] });
    const { id } = manager.spawn('cat', '/tmp', ENV);

    manager.writeStdin(id, '\x03');
    expect(killSpy).toHaveBeenCalledWith(-999, 'SIGINT');
  });

  it('kill terminates the process group and is idempotent', () => {
    const child = new MockChild(555);
    const { manager } = buildManager({ children: [child] });
    const { id } = manager.spawn('sleep 100', '/tmp', ENV);

    expect(manager.kill(id)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(-555, 'SIGTERM');
    expect(manager.get(id)?.status).toBe('killed');

    // Already terminal -> no-op.
    expect(manager.kill(id)).toBe(false);
    expect(manager.writeStdin(id, 'x')).toBe(false);
  });

  it('does not clobber a killed status when the child later closes', () => {
    const child = new MockChild();
    const { manager } = buildManager({ children: [child] });
    const { id } = manager.spawn('sleep 100', '/tmp', ENV);

    manager.kill(id);
    child.close(null); // late close from the SIGTERM
    expect(manager.get(id)?.status).toBe('killed');
  });

  it('killAll terminates every running session', () => {
    const a = new MockChild(1);
    const b = new MockChild(2);
    const { manager } = buildManager({ children: [a, b] });
    manager.spawn('a', '/tmp', ENV);
    const second = manager.spawn('b', '/tmp', ENV);
    b.close(0); // one already terminal

    manager.killAll();
    expect(killSpy).toHaveBeenCalledWith(-1, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(-2, expect.anything());
    expect(manager.get(second.id)?.status).toBe('exited');
  });

  it('evicts terminal sessions past the retention window on next spawn', () => {
    let clock = 0;
    const { manager } = buildManager({
      children: [new MockChild(1), new MockChild(2)],
      now: () => clock,
      retentionMs: 100,
    });
    const first = manager.spawn('a', '/tmp', ENV);
    manager.kill(first.id); // terminate at t=0

    clock = 200; // past retention
    manager.spawn('b', '/tmp', ENV); // triggers eviction sweep

    expect(manager.get(first.id)).toBeUndefined();
    expect(manager.size).toBe(1);
  });

  it('rejects new sessions once the concurrent-running cap is reached', () => {
    const children = [new MockChild(1), new MockChild(2), new MockChild(3)];
    const { manager } = buildManager({ children, maxRunning: 2 });

    manager.spawn('a', '/tmp', ENV);
    const second = manager.spawn('b', '/tmp', ENV);
    expect(() => manager.spawn('c', '/tmp', ENV)).toThrow(/Too many background shell sessions/);

    // Freeing a slot lets the next spawn through.
    manager.kill(second.id);
    expect(() => manager.spawn('c', '/tmp', ENV)).not.toThrow();
    expect(manager.runningCount()).toBe(2);
  });

  it('does not let a throwing subscriber break bookkeeping or other listeners', () => {
    const child = new MockChild();
    const { manager } = buildManager({ children: [child] });
    const seen: string[] = [];
    manager.subscribe(() => {
      throw new Error('bad subscriber');
    });
    manager.subscribe(s => seen.push(s.status));

    const { id } = manager.spawn('true', '/tmp', ENV);
    child.close(0);

    expect(seen).toEqual(['running', 'exited']); // second listener still fired
    expect(manager.get(id)?.status).toBe('exited'); // state intact
  });

  it('LRU-caps total sessions by dropping the oldest terminal ones', () => {
    let clock = 0;
    const children = [new MockChild(1), new MockChild(2), new MockChild(3)];
    const { manager } = buildManager({ children, now: () => ++clock, maxSessions: 2, retentionMs: 10_000 });

    const s1 = manager.spawn('a', '/tmp', ENV);
    manager.kill(s1.id); // terminal, oldest
    const s2 = manager.spawn('b', '/tmp', ENV);
    manager.kill(s2.id); // terminal
    manager.spawn('c', '/tmp', ENV); // at cap -> evict oldest terminal (s1)

    expect(manager.get(s1.id)).toBeUndefined();
    expect(manager.get(s2.id)).toBeDefined();
    expect(manager.size).toBe(2);
  });
});
