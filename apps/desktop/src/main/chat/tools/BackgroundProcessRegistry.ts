import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { BackgroundProcessInfo, BackgroundProcessStatus } from '@shared/chat';
import { PARENT_WATCH_FD, wrapWithParentWatchdog } from './backgroundScript';
import { OutputBuffer, type OutputStream } from './outputBuffer';
import { sandboxCommand, type SandboxedCommand } from './sandbox';

/** Retained per process. The tail is what matters for a watcher; see OutputBuffer. */
const MAX_BUFFERED_CHARS = 200_000;

/** Between asking a process group to stop and killing it outright. */
const SIGKILL_DELAY_MS = 3_000;

/** How long `shutdown` gives every group to exit on SIGTERM before it stops being polite. */
const SHUTDOWN_GRACE_MS = 2_000;

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
  /**
   * Run outside the Seatbelt profile, with these environment overrides. For work the APP
   * starts on its own initiative (a dependency install), never for anything the model asked
   * for: the sandbox is what confines model-authored commands.
   */
  unsandboxed?: { env?: NodeJS.ProcessEnv };
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
  sandbox: SandboxedCommand;
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
 * Signals go to the process GROUP (`-pgid`), never the bare pid: signalling sandbox-exec alone
 * would leave the bash it spawned, and whatever that spawned, running.
 */
export class BackgroundProcessRegistry {
  private readonly processes = new Map<string, Tracked>();
  private shuttingDown = false;

  constructor(private readonly events: BackgroundProcessEvents) {}

  async start(request: StartRequest): Promise<BackgroundProcessInfo> {
    if (this.shuttingDown) throw new Error('The app is shutting down; no new commands can be started.');
    this.enforceLimits(request.sessionId);

    const wrapped = wrapWithParentWatchdog(request.command);
    const sandboxed: SandboxedCommand = request.unsandboxed
      ? { executable: '/bin/bash', args: ['-c', wrapped], cleanup: async () => undefined }
      : await sandboxCommand(wrapped, request.roots, request.protectedPaths);

    const id = randomUUID().slice(0, 8);
    const info: BackgroundProcessInfo = {
      id,
      sessionId: request.sessionId,
      command: request.command,
      cwd: request.cwd,
      status: 'running',
      startedAt: new Date().toISOString(),
      bufferedChars: 0,
      droppedChars: 0,
    };

    let child: ChildProcess;
    try {
      child = spawn(sandboxed.executable, sandboxed.args, {
        cwd: request.cwd,
        // Detached so the child leads its own process group: that is what makes one signal
        // reach the command's whole tree rather than just the sandbox wrapper.
        detached: true,
        // fd 3 is the watch pipe the child blocks on. Its write end stays open in this process
        // for exactly as long as this process lives, which is the entire mechanism.
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        env: request.unsandboxed
          ? { ...process.env, ...request.unsandboxed.env, B4M_DESKTOP_BACKGROUND: '1' }
          : { ...process.env, B4M_DESKTOP_SANDBOX: '1', B4M_DESKTOP_BACKGROUND: '1' },
      });
    } catch (err) {
      await sandboxed.cleanup();
      throw err;
    }

    const tracked: Tracked = {
      info,
      child,
      pgid: child.pid ?? null,
      buffer: new OutputBuffer(MAX_BUFFERED_CHARS),
      modelCursor: 0,
      sandbox: sandboxed,
      decoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') },
      pendingEmit: [],
      emitTimer: null,
      killTimer: null,
      closed: Promise.resolve(),
    };

    tracked.closed = new Promise<void>(resolve => {
      child.on('error', error => {
        this.finish(tracked, 'failed', null, null, error.message);
        resolve();
      });
      child.on('close', (code, signal) => {
        this.finish(tracked, tracked.info.status === 'killed' ? 'killed' : 'exited', code, signal);
        resolve();
      });
    });

    // Never written to, only held open. Unref'd so an idle pipe cannot be the thing keeping
    // the app alive at quit.
    child.stdio[PARENT_WATCH_FD]?.on('error', () => undefined);
    (child.stdio[PARENT_WATCH_FD] as { unref?(): void } | undefined)?.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => this.ingest(tracked, 'stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.ingest(tracked, 'stderr', chunk));

    this.processes.set(id, tracked);
    this.events.status(request.sessionId, { ...info });
    return { ...info };
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

    void tracked.sandbox.cleanup();
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
