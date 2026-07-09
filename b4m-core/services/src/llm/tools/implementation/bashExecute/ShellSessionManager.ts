import { type ChildProcessWithoutNullStreams, spawn } from 'child_process';

/**
 * Lifecycle state of a background shell session.
 * - `running`   : the child process is still alive.
 * - `exited`    : the child exited on its own (see `exitCode`).
 * - `killed`    : the child was terminated by us (kill_background_shell / killAll / interrupt).
 * - `timed_out` : the child outlived its hard wall-clock budget and was terminated.
 */
export type ShellSessionStatus = 'running' | 'exited' | 'killed' | 'timed_out';

/** Public, serializable snapshot of a session. Never exposes the child handle. */
export interface ShellSession {
  id: string;
  command: string;
  cwd: string;
  status: ShellSessionStatus;
  /** Process exit code once terminal; null while running or if killed by signal. */
  exitCode: number | null;
  startTime: number;
  /** Set once the session reaches a terminal status. */
  endTime?: number;
  /** OS process id of the group leader (spawned detached), if known. */
  pid?: number;
  /** Total chars of combined output ever produced (monotonic; the poll cursor). */
  totalOutputChars: number;
}

/** Result of an offset-based output poll. */
export interface ShellOutputSlice {
  /** Output produced since the requested offset (capped to the retained buffer). */
  output: string;
  /** New cursor to pass as `sinceOffset` on the next poll. */
  offset: number;
  /** True when the requested offset predated the retained buffer (some output was dropped). */
  truncated: boolean;
  status: ShellSessionStatus;
  exitCode: number | null;
}

/** A subscriber notified on every session lifecycle change. Returns an unsubscribe fn. */
export type ShellSessionListener = (session: ShellSession) => void;

export interface ShellSessionManagerOptions {
  /** Max retained output chars per session (older output is dropped, offsets stay monotonic). */
  maxOutputChars?: number;
  /** Max total sessions retained before evicting the oldest terminal ones. */
  maxSessions?: number;
  /** Max concurrently *running* sessions before spawn() rejects (bounds live child processes). */
  maxRunning?: number;
  /** How long a terminal session's output stays pollable before eviction (ms). */
  retentionMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable spawn for tests (defaults to child_process.spawn). */
  spawnFn?: typeof spawn;
}

/** Thrown by spawn() when the concurrent-running-session cap is reached. */
export class TooManyShellSessionsError extends Error {
  constructor(public readonly limit: number) {
    super(
      `Too many background shell sessions already running (limit ${limit}). ` +
        `Stop one with kill_background_shell before starting another.`
    );
    this.name = 'TooManyShellSessionsError';
  }
}

const DEFAULT_MAX_OUTPUT_CHARS = 256 * 1024;
const DEFAULT_MAX_SESSIONS = 50;
const DEFAULT_MAX_RUNNING = 10;
const DEFAULT_RETENTION_MS = 30 * 60 * 1000; // 30 minutes
const SIGKILL_ESCALATION_MS = 5000;
const INTERRUPT_CHAR = '\x03';

const TERMINAL_STATUSES: ReadonlySet<ShellSessionStatus> = new Set(['exited', 'killed', 'timed_out']);

/** True once a session has finished (exited, killed, or timed out) and won't change. */
export function isTerminalShellStatus(status: ShellSessionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function isTerminal(status: ShellSessionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Internal record: the public snapshot plus the live child and retained output. */
interface InternalSession {
  snapshot: ShellSession;
  child: ChildProcessWithoutNullStreams;
  /** Last <= maxOutputChars chars of combined stdout+stderr. */
  buffer: string;
}

/**
 * Process-global manager for backgroundable shell sessions.
 *
 * `bash_execute` is a CLI-only tool (see cliTools.ts), so a single in-process
 * registry is safe - there is no Lambda cross-invocation reuse to worry about.
 *
 * Responsibilities:
 * - spawn children *detached* so we can signal the whole process group and never
 *   orphan a `pnpm dev` / watcher;
 * - retain a bounded, offset-addressable output buffer per session for polling;
 * - expose stdin writes and interrupts to running children;
 * - bound memory via an LRU cap + a retention window for terminal sessions;
 * - emit lifecycle changes so the CLI (issue #310) can render live indicators.
 */
export class ShellSessionManager {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly listeners = new Set<ShellSessionListener>();
  private readonly maxOutputChars: number;
  private readonly maxSessions: number;
  private readonly maxRunning: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly spawnFn: typeof spawn;
  private sequence = 0;

  constructor(options: ShellSessionManagerOptions = {}) {
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxRunning = options.maxRunning ?? DEFAULT_MAX_RUNNING;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.now = options.now ?? Date.now;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  /**
   * Subscribe to lifecycle changes (create + every status transition).
   * Returns an unsubscribe function.
   */
  subscribe(listener: ShellSessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Spawn a command as a background session and return its snapshot immediately.
   * The child is detached so its process group can be signalled as a unit.
   */
  spawn(command: string, cwd: string, env: NodeJS.ProcessEnv): ShellSession {
    this.evictIfNeeded();

    // Terminal sessions are memory-bounded by eviction, but live children are a
    // real resource - refuse to start more than maxRunning at once rather than
    // silently accumulating orphanable processes.
    if (this.runningCount() >= this.maxRunning) {
      throw new TooManyShellSessionsError(this.maxRunning);
    }

    const id = `sh-${(++this.sequence).toString(36)}-${this.now().toString(36)}`;
    const child = this.spawnFn('bash', ['-c', command], {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    const snapshot: ShellSession = {
      id,
      command,
      cwd,
      status: 'running',
      exitCode: null,
      startTime: this.now(),
      pid: child.pid,
      totalOutputChars: 0,
    };

    const session: InternalSession = { snapshot, child, buffer: '' };
    this.sessions.set(id, session);

    // stdout and stderr share one interleaved buffer - session output is meant to
    // read like a terminal, where the two streams are already merged. (Foreground
    // bash_execute keeps them separate; session mode deliberately does not.)
    child.stdout.on('data', (data: Buffer) => this.append(session, data.toString()));
    child.stderr.on('data', (data: Buffer) => this.append(session, data.toString()));

    child.on('close', exitCode => {
      // A kill()/timeout already set a terminal status; don't clobber it.
      if (isTerminal(session.snapshot.status)) return;
      this.transition(session, 'exited', exitCode);
    });

    child.on('error', error => {
      this.append(session, `\n[shell error] ${error.message}\n`);
      if (!isTerminal(session.snapshot.status)) {
        this.transition(session, 'killed', null);
      }
    });

    // A child that ignores stdin can close its read end early; swallow the
    // resulting EPIPE so a pending write doesn't crash the process.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') {
        this.append(session, `\n[stdin error] ${error.message}\n`);
      }
    });

    this.emit(session);
    return { ...snapshot };
  }

  /** Public snapshot for a session, or undefined if unknown. */
  get(id: string): ShellSession | undefined {
    const session = this.sessions.get(id);
    return session ? { ...session.snapshot } : undefined;
  }

  /** Snapshots of all retained sessions, oldest first. */
  list(): ShellSession[] {
    return Array.from(this.sessions.values()).map(s => ({ ...s.snapshot }));
  }

  /**
   * Read output produced since `sinceOffset` (absolute char cursor).
   * Omit `sinceOffset` to read the entire retained buffer.
   */
  getOutput(id: string, sinceOffset?: number): ShellOutputSlice | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;

    const { snapshot, buffer } = session;
    const bufferStart = snapshot.totalOutputChars - buffer.length;
    const requested = sinceOffset ?? bufferStart;
    const clamped = Math.max(requested, bufferStart);
    const output = buffer.slice(clamped - bufferStart);

    return {
      output,
      offset: snapshot.totalOutputChars,
      truncated: requested < bufferStart,
      status: snapshot.status,
      exitCode: snapshot.exitCode,
    };
  }

  /**
   * Write to a running child's stdin. A lone INTERRUPT_CHAR (Ctrl-C) is treated
   * as an interrupt (SIGINT) rather than literal input. Returns false if the
   * session is unknown or already terminal.
   */
  writeStdin(id: string, chars: string): boolean {
    const session = this.sessions.get(id);
    if (!session || isTerminal(session.snapshot.status)) return false;

    if (chars.includes(INTERRUPT_CHAR)) {
      this.signalGroup(session, 'SIGINT');
      const rest = chars.split(INTERRUPT_CHAR).join('');
      if (rest.length > 0) session.child.stdin.write(rest);
      return true;
    }

    session.child.stdin.write(chars);
    return true;
  }

  /**
   * Terminate a running session's process group (SIGTERM, escalating to SIGKILL).
   * Returns false if the session is unknown or already terminal.
   */
  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session || isTerminal(session.snapshot.status)) return false;
    this.terminate(session, 'killed');
    return true;
  }

  /** Mark a session as timed out and terminate its group. */
  markTimedOut(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session || isTerminal(session.snapshot.status)) return false;
    this.terminate(session, 'timed_out');
    return true;
  }

  /** Terminate every running session. Call on CLI shutdown to avoid orphans. */
  killAll(): void {
    for (const session of this.sessions.values()) {
      if (!isTerminal(session.snapshot.status)) {
        this.terminate(session, 'killed');
      }
    }
  }

  /** Number of retained sessions (for tests/monitoring). */
  get size(): number {
    return this.sessions.size;
  }

  /** Number of sessions currently running (non-terminal). */
  runningCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (!isTerminal(session.snapshot.status)) count++;
    }
    return count;
  }

  private terminate(session: InternalSession, status: Extract<ShellSessionStatus, 'killed' | 'timed_out'>): void {
    this.transition(session, status, null);
    this.signalGroup(session, 'SIGTERM');
    setTimeout(() => {
      if (session.child.exitCode === null && session.child.signalCode === null) {
        this.signalGroup(session, 'SIGKILL');
      }
    }, SIGKILL_ESCALATION_MS).unref?.();
  }

  /** Send a signal to the child's whole process group; ignore already-dead. */
  private signalGroup(session: InternalSession, signal: NodeJS.Signals): void {
    const { pid } = session.child;
    if (pid === undefined) return;
    try {
      // Negative pid targets the process group (child spawned detached).
      process.kill(-pid, signal);
    } catch {
      // ESRCH: the group is already gone. Nothing to do.
    }
  }

  private append(session: InternalSession, chunk: string): void {
    session.snapshot.totalOutputChars += chunk.length;
    const combined = session.buffer + chunk;
    session.buffer =
      combined.length > this.maxOutputChars ? combined.slice(combined.length - this.maxOutputChars) : combined;
  }

  private transition(session: InternalSession, status: ShellSessionStatus, exitCode: number | null): void {
    session.snapshot.status = status;
    session.snapshot.exitCode = exitCode;
    if (isTerminal(status)) {
      session.snapshot.endTime = this.now();
    }
    this.emit(session);
  }

  private emit(session: InternalSession): void {
    const snapshot = { ...session.snapshot };
    for (const listener of this.listeners) {
      // A misbehaving subscriber (e.g. the CLI store) must never break session
      // bookkeeping or starve the remaining listeners.
      try {
        listener(snapshot);
      } catch {
        // Intentionally swallowed - subscriber errors are not the manager's problem.
      }
    }
  }

  /**
   * Evict terminal sessions to keep memory bounded: first drop any past the
   * retention window, then, if still at the cap, drop the oldest terminal ones.
   */
  private evictIfNeeded(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, session] of this.sessions) {
      if (isTerminal(session.snapshot.status) && (session.snapshot.endTime ?? 0) < cutoff) {
        this.sessions.delete(id);
      }
    }

    if (this.sessions.size < this.maxSessions) return;

    const terminalOldestFirst = Array.from(this.sessions.entries())
      .filter(([, s]) => isTerminal(s.snapshot.status))
      .sort((a, b) => (a[1].snapshot.endTime ?? 0) - (b[1].snapshot.endTime ?? 0));

    for (const [id] of terminalOldestFirst) {
      if (this.sessions.size < this.maxSessions) break;
      this.sessions.delete(id);
    }
  }
}

// Pin the singleton to globalThis (not a module-level `let`) so there is exactly
// ONE manager per process even if this module is duplicated across bundle chunks -
// bash_execute is dynamically imported while the CLI subscribes statically, and a
// split instance would mean the UI never sees the tool's sessions and killAll() on
// exit would miss the real children (silently orphaning them).
const SINGLETON_KEY = Symbol.for('@bike4mind/services:ShellSessionManager');
type SingletonHost = { [SINGLETON_KEY]?: ShellSessionManager };

/** Lazily-created process-global manager used by the bash_execute tool family. */
export function getShellSessionManager(): ShellSessionManager {
  const host = globalThis as SingletonHost;
  if (!host[SINGLETON_KEY]) {
    host[SINGLETON_KEY] = new ShellSessionManager();
  }
  return host[SINGLETON_KEY];
}
