import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { BackgroundProcessInfo, BackgroundProcessStatus } from '@shared/chat';
import { PARENT_WATCH_FD, wrapWithParentWatchdog } from './backgroundScript';
import { OutputBuffer, type OutputStream } from './outputBuffer';
import { commandEnv, launchCommand } from './commandLaunch';
import type { SandboxedCommand } from './sandbox';

/** Retained per process. The tail is what matters for a watcher; see OutputBuffer. */
const MAX_BUFFERED_CHARS = 200_000;

/** Between asking a process group to stop and killing it outright. */
const SIGKILL_DELAY_MS = 3_000;

/** How long `shutdown` gives every group to exit on SIGTERM before it stops being polite. */
const SHUTDOWN_GRACE_MS = 2_000;

/**
 * How long a command's pipes get to drain after it has exited, before the record is finished
 * without them.
 *
 * When the whole group goes down together the two arrive in the same millisecond, so this is
 * only ever spent on a command that left something holding its output. See the 'exit' handler.
 */
const STDIO_DRAIN_MS = 500;

/** Live output is coalesced into one IPC push per process per tick; a watcher can emit constantly. */
const EMIT_INTERVAL_MS = 100;

/**
 * Concurrency ceilings. A model that starts a server per turn would otherwise accumulate them
 * silently, and every one of them is a real process holding real ports.
 */
const MAX_RUNNING_PER_SESSION = 5;
const MAX_RUNNING_TOTAL = 10;

/** Finished processes kept for their output. Oldest are pruned; running ones are never pruned. */
const MAX_FINISHED_PER_SESSION = 10;

export interface StartRequest {
  sessionId: string;
  command: string;
  cwd: string;
  roots: readonly string[];
  protectedPaths: readonly string[];
}

/**
 * A command that is ALREADY running, handed over by the foreground runner. See `adopt`.
 *
 * Everything here describes a spawn that has happened: there is nothing left to decide about
 * how the process starts, only who is responsible for it from now on.
 */
export interface AdoptRequest {
  sessionId: string;
  command: string;
  cwd: string;
  /** Detached, with stdout and stderr piped, and no other reader left on them. */
  child: ChildProcess;
  /** The detached child's own pid, which is its process group id; null when it never spawned. */
  pgid: number | null;
  /** When the command started, not when it was moved: the panel's clock counts from here. */
  startedAt: string;
  /** Handed over with the child, and run by `finish` when the command ends. */
  launch: SandboxedCommand;
  /** What the foreground runner collected before the move, so none of it is lost on the way. */
  captured?: readonly { stream: OutputStream; text: string }[];
}

export interface ReadResult {
  info: BackgroundProcessInfo;
  text: string;
  cursor: number;
  missed: number;
}

interface Tracked {
  info: BackgroundProcessInfo;
  child: ChildProcess;
  /** The process group id, which is the detached child's own pid. Null once it is gone. */
  pgid: number | null;
  buffer: OutputBuffer;
  /** Where the MODEL has read to. The UI streams live and keeps no cursor. */
  modelCursor: number;
  launch: SandboxedCommand;
  decoders: Record<OutputStream, StringDecoder>;
  pendingEmit: { stream: OutputStream; text: string }[];
  emitTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  closed: Promise<void>;
}

export interface BackgroundProcessEvents {
  output(sessionId: string, processId: string, stream: OutputStream, text: string): void;
  status(sessionId: string, info: BackgroundProcessInfo): void;
}

export class BackgroundProcessLimit extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundProcessLimit';
  }
}

/**
 * Every background command this app has started, and the guarantee that none of them outlives it.
 *
 * Three independent mechanisms enforce that guarantee, because each covers a hole in the others:
 *
 *  1. `shutdown()` on quit - SIGTERM the groups, wait, then SIGKILL. The polite path.
 *  2. `shutdownSync()` on `will-quit` - a synchronous SIGKILL sweep, because that handler cannot
 *     await and a quit that races the grace period must not leave anything behind.
 *  3. The in-child watchdog (see backgroundScript.ts) - the only one that survives main being
 *     SIGKILLed or crashing, which is exactly how a dev server was left holding port 3000 for
 *     three days.
 *
 * Nothing here is persisted. A background process does not survive a restart, and on the next
 * launch the list is empty rather than showing handles for processes that no longer exist - a
 * stale handle the model could call `bash_output` on is worse than no handle at all.
 *
 * Signals go to the process GROUP (`-pgid`), never the bare pid: signalling the shell alone
 * would leave whatever it spawned running.
 */
export class BackgroundProcessRegistry {
  private readonly processes = new Map<string, Tracked>();
  private shuttingDown = false;

  constructor(private readonly events: BackgroundProcessEvents) {}

  async start(request: StartRequest): Promise<BackgroundProcessInfo> {
    if (this.shuttingDown) throw new Error('The app is shutting down; no new commands can be started.');
    this.enforceLimits(request.sessionId);

    const wrapped = wrapWithParentWatchdog(request.command);
    const launch = await launchCommand(wrapped, request.roots, request.protectedPaths);

    const info = this.newInfo(request.sessionId, request.command, request.cwd, new Date().toISOString());

    let child: ChildProcess;
    try {
      const env = await commandEnv({ B4M_DESKTOP_BACKGROUND: '1' });
      child = spawn(launch.executable, launch.args, {
        cwd: request.cwd,
        // Detached so the child leads its own process group: that is what makes one signal
        // reach the command's whole tree rather than just the shell.
        detached: true,
        // fd 3 is the watch pipe the child blocks on. Its write end stays open in this process
        // for exactly as long as this process lives, which is the entire mechanism.
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        env,
      });
    } catch (err) {
      await launch.cleanup();
      throw err;
    }

    const tracked = this.track(info, child, child.pid ?? null, launch);

    // Never written to, only held open. Unref'd so an idle pipe cannot be the thing keeping
    // the app alive at quit.
    child.stdio[PARENT_WATCH_FD]?.on('error', () => undefined);
    (child.stdio[PARENT_WATCH_FD] as { unref?(): void } | undefined)?.unref?.();

    this.processes.set(info.id, tracked);
    this.events.status(request.sessionId, { ...info });
    return { ...info };
  }

  /**
   * Take over a command that is already running in the foreground, so a build or a test run
   * nobody wants to keep waiting on carries on without the turn waiting with it.
   *
   * One guarantee is weaker here than for `start`, and cannot be made stronger. `start` wraps
   * its command in the fd-3 watchdog (see backgroundScript.ts), which is the only teardown
   * that survives this app being SIGKILLed or crashing; a foreground command was spawned
   * without that pipe, and a descriptor cannot be fitted to a process that is already running.
   * So an adopted process outlives a CRASH. A graceful quit still takes it down - `shutdown`
   * and `shutdownSync` signal its group like any other, and the group is the child's own
   * because the foreground runner spawns detached for exactly that reason.
   *
   * `B4M_DESKTOP_BACKGROUND` is missing on an adopted child for the same reason - env is fixed
   * at spawn - and nothing in this repository reads it today.
   */
  adopt(request: AdoptRequest): BackgroundProcessInfo {
    if (this.shuttingDown) throw new Error('The app is shutting down; no command can be moved to the background.');
    // The same gate `start` passes through: adoption that skipped it would be a way around the cap.
    this.enforceLimits(request.sessionId);

    const info = this.newInfo(request.sessionId, request.command, request.cwd, request.startedAt);
    const tracked = this.track(info, request.child, request.pgid, request.launch);

    for (const chunk of request.captured ?? []) {
      if (chunk.text) tracked.buffer.push(chunk.stream, chunk.text);
    }
    info.bufferedChars = tracked.buffer.retainedChars;

    this.processes.set(info.id, tracked);
    this.events.status(request.sessionId, { ...info });
    return { ...info };
  }

  private newInfo(sessionId: string, command: string, cwd: string, startedAt: string): BackgroundProcessInfo {
    return {
      id: randomUUID().slice(0, 8),
      sessionId,
      command,
      cwd,
      status: 'running',
      startedAt,
      bufferedChars: 0,
      droppedChars: 0,
    };
  }

  /** The lifetime wiring every tracked process shares, however this registry came by its child. */
  private track(
    info: BackgroundProcessInfo,
    child: ChildProcess,
    pgid: number | null,
    launch: SandboxedCommand
  ): Tracked {
    const tracked: Tracked = {
      info,
      child,
      pgid,
      buffer: new OutputBuffer(MAX_BUFFERED_CHARS),
      modelCursor: 0,
      launch,
      decoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') },
      pendingEmit: [],
      emitTimer: null,
      killTimer: null,
      closed: Promise.resolve(),
    };

    tracked.closed = new Promise<void>(resolve => {
      const settle = (
        status: BackgroundProcessStatus,
        code: number | null,
        signal: NodeJS.Signals | null,
        error?: string
      ): void => {
        this.finish(tracked, status, code, signal, error);
        resolve();
      };
      const ended = (): BackgroundProcessStatus => (tracked.info.status === 'killed' ? 'killed' : 'exited');

      child.on('error', error => settle('failed', null, null, error.message));

      // The better of the two when it comes: 'close' means the output has drained as well.
      child.on('close', (code, signal) => settle(ended(), code, signal));

      // ...but it only fires once EVERY holder of the pipes has let go, and a descendant that
      // escaped the process group is still a holder - `npm run dev &`, or anything that calls
      // setsid. The command itself is over at 'exit'. Waiting past that for pipes nobody is
      // going to close is what left a stopped task sitting under Running with its clock
      // ticking for the rest of the app's life, which is what made Stop look broken.
      child.on('exit', (code, signal) => {
        if (tracked.info.endedAt) return;
        const drain = setTimeout(() => settle(ended(), code, signal), STDIO_DRAIN_MS);
        drain.unref?.();
      });
    });

    child.stdout?.on('data', (chunk: Buffer) => this.ingest(tracked, 'stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.ingest(tracked, 'stderr', chunk));

    return tracked;
  }

  /** Wait up to `ms` for the process to end on its own - how `bash_background` settles. */
  async settle(id: string, ms: number): Promise<void> {
    const tracked = this.processes.get(id);
    if (!tracked) return;
    await Promise.race([tracked.closed, new Promise<void>(resolve => setTimeout(resolve, ms).unref?.())]);
  }

  get(id: string, sessionId: string): BackgroundProcessInfo | null {
    const tracked = this.processes.get(id);
    // Scoped by session: one conversation must not be able to reach another's processes just
    // by guessing a handle.
    if (!tracked || tracked.info.sessionId !== sessionId) return null;
    return { ...tracked.info };
  }

  /**
   * Running processes across every session, for the one caller that is not session-scoped:
   * deciding whether quitting would strand work. Finished entries linger in the map until they
   * are pruned, so this counts status rather than size.
   */
  runningCount(): number {
    let running = 0;
    for (const tracked of this.processes.values()) {
      if (tracked.info.status === 'running') running += 1;
    }
    return running;
  }

  list(sessionId: string): BackgroundProcessInfo[] {
    return [...this.processes.values()]
      .filter(tracked => tracked.info.sessionId === sessionId)
      .map(tracked => ({ ...tracked.info }));
  }

  /** Output since the model's last read. `fromStart` re-reads the whole retained buffer. */
  readForModel(id: string, sessionId: string, maxChars: number, fromStart = false): ReadResult | null {
    const tracked = this.processes.get(id);
    if (!tracked || tracked.info.sessionId !== sessionId) return null;

    const slice = tracked.buffer.read(fromStart ? 0 : tracked.modelCursor, maxChars);
    tracked.modelCursor = slice.cursor;
    return { info: { ...tracked.info }, text: slice.text, cursor: slice.cursor, missed: slice.missed };
  }

  /** The newest output, for the UI, which has no cursor of its own to keep. */
  tail(id: string, sessionId: string, maxChars: number): string | null {
    const tracked = this.processes.get(id);
    if (!tracked || tracked.info.sessionId !== sessionId) return null;
    return tracked.buffer.tail(maxChars);
  }

  /** SIGTERM the group, SIGKILL after a grace period. Resolves once it is actually gone. */
  async kill(id: string, sessionId: string): Promise<BackgroundProcessInfo | null> {
    const tracked = this.processes.get(id);
    if (!tracked || tracked.info.sessionId !== sessionId) return null;
    if (tracked.info.status !== 'running') return { ...tracked.info };

    tracked.info.status = 'killed';
    this.stop(tracked);
    await tracked.closed;
    return { ...tracked.info };
  }

  /** Deleting a conversation takes its processes with it - there is no UI left to stop them. */
  async killSession(sessionId: string): Promise<void> {
    const owned = [...this.processes.values()].filter(tracked => tracked.info.sessionId === sessionId);
    for (const tracked of owned) {
      if (tracked.info.status === 'running') {
        tracked.info.status = 'killed';
        this.stop(tracked);
      }
    }
    await Promise.all(owned.map(tracked => tracked.closed));
    for (const tracked of owned) this.processes.delete(tracked.info.id);
  }

  /**
   * The polite teardown, for quit. SIGTERM everything, give it a moment to shut down cleanly
   * (a dev server gets to release its port and flush), then SIGKILL whatever is left.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const running = [...this.processes.values()].filter(tracked => tracked.info.status === 'running');
    if (running.length === 0) return;

    for (const tracked of running) {
      tracked.info.status = 'killed';
      this.signalGroup(tracked, 'SIGTERM');
    }

    await Promise.race([
      Promise.all(running.map(tracked => tracked.closed)),
      new Promise<void>(resolve => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref?.()),
    ]);

    for (const tracked of running) this.signalGroup(tracked, 'SIGKILL');
  }

  /**
   * The last-resort sweep, for `will-quit`, which cannot await anything.
   *
   * SIGKILL rather than SIGTERM: by this point the app is going regardless, and a group that
   * ignores SIGTERM would be the leak. Safe to call after `shutdown`, and safe to call twice.
   */
  shutdownSync(): void {
    this.shuttingDown = true;
    for (const tracked of this.processes.values()) {
      this.signalGroup(tracked, 'SIGKILL');
      if (tracked.killTimer) clearTimeout(tracked.killTimer);
      if (tracked.emitTimer) clearTimeout(tracked.emitTimer);
    }
  }

  private enforceLimits(sessionId: string): void {
    const running = [...this.processes.values()].filter(tracked => tracked.info.status === 'running');
    if (running.length >= MAX_RUNNING_TOTAL) {
      throw new BackgroundProcessLimit(
        `Too many background commands are already running (${MAX_RUNNING_TOTAL}). Stop one with bash_kill first.`
      );
    }
    if (running.filter(tracked => tracked.info.sessionId === sessionId).length >= MAX_RUNNING_PER_SESSION) {
      throw new BackgroundProcessLimit(
        `This conversation already has ${MAX_RUNNING_PER_SESSION} background commands running. ` +
          'Stop one with bash_kill before starting another.'
      );
    }
  }

  private ingest(tracked: Tracked, stream: OutputStream, chunk: Buffer): void {
    // Decoded incrementally so a multi-byte character split across two chunks does not become
    // replacement characters.
    const text = tracked.decoders[stream].write(chunk);
    if (!text) return;

    tracked.buffer.push(stream, text);
    tracked.info.bufferedChars = tracked.buffer.retainedChars;
    tracked.info.droppedChars = tracked.buffer.droppedChars;

    tracked.pendingEmit.push({ stream, text });
    if (tracked.emitTimer) return;
    tracked.emitTimer = setTimeout(() => this.flushEmit(tracked), EMIT_INTERVAL_MS);
    tracked.emitTimer.unref?.();
  }

  private flushEmit(tracked: Tracked): void {
    tracked.emitTimer = null;
    const pending = tracked.pendingEmit;
    tracked.pendingEmit = [];
    if (pending.length === 0) return;

    // Runs of the same stream are merged, so a chatty command is one push per stream per tick
    // rather than one per write.
    let run: { stream: OutputStream; text: string } | null = null;
    for (const entry of pending) {
      if (run && run.stream === entry.stream) {
        run.text += entry.text;
        continue;
      }
      if (run) this.events.output(tracked.info.sessionId, tracked.info.id, run.stream, run.text);
      run = { ...entry };
    }
    if (run) this.events.output(tracked.info.sessionId, tracked.info.id, run.stream, run.text);
  }

  private stop(tracked: Tracked): void {
    this.signalGroup(tracked, 'SIGTERM');
    if (tracked.killTimer) clearTimeout(tracked.killTimer);
    tracked.killTimer = setTimeout(() => this.signalGroup(tracked, 'SIGKILL'), SIGKILL_DELAY_MS);
    tracked.killTimer.unref?.();
  }

  private signalGroup(tracked: Tracked, signal: NodeJS.Signals): void {
    if (tracked.pgid === null) return;
    try {
      process.kill(-tracked.pgid, signal);
    } catch {
      // ESRCH: already gone. Nothing to do, and nothing worth telling the user about.
    }
  }

  private finish(
    tracked: Tracked,
    status: BackgroundProcessStatus,
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: string
  ): void {
    if (tracked.info.endedAt) return;

    for (const stream of ['stdout', 'stderr'] as const) {
      const tail = tracked.decoders[stream].end();
      if (tail) tracked.buffer.push(stream, tail);
    }
    if (tracked.emitTimer) clearTimeout(tracked.emitTimer);
    this.flushEmit(tracked);

    // The leader exiting does not empty its group: `npm run dev &` inside the command leaves
    // the server behind with the watchdog already dismissed. Sweep the group either way.
    this.signalGroup(tracked, 'SIGTERM');
    if (tracked.killTimer) clearTimeout(tracked.killTimer);
    tracked.pgid = null;

    tracked.info.status = status;
    tracked.info.endedAt = new Date().toISOString();
    tracked.info.exitCode = code;
    tracked.info.signal = signal;
    tracked.info.bufferedChars = tracked.buffer.retainedChars;
    tracked.info.droppedChars = tracked.buffer.droppedChars;
    if (error) tracked.info.error = error;

    void tracked.launch.cleanup();
    this.pruneFinished(tracked.info.sessionId);
    this.events.status(tracked.info.sessionId, { ...tracked.info });
  }

  /** Keep the newest finished entries so their output stays readable; drop the rest. */
  private pruneFinished(sessionId: string): void {
    const finished = [...this.processes.values()].filter(
      tracked => tracked.info.sessionId === sessionId && tracked.info.status !== 'running'
    );
    if (finished.length <= MAX_FINISHED_PER_SESSION) return;

    finished
      .sort((a, b) => (a.info.endedAt ?? '').localeCompare(b.info.endedAt ?? ''))
      .slice(0, finished.length - MAX_FINISHED_PER_SESSION)
      .forEach(tracked => this.processes.delete(tracked.info.id));
  }
}
