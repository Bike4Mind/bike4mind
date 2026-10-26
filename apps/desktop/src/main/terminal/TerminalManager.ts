import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { IPC_CHANNELS } from '@shared/ipc';
import {
  MAX_TERMINALS_PER_SESSION,
  type TerminalAttachment,
  type TerminalCreateResult,
  type TerminalInfo,
} from '@shared/terminal';

/** Output is coalesced for this long before it crosses to a window (ms): one frame. */
const FLUSH_MS = 16;

/** A batch this large goes at once rather than waiting out the frame (chars). */
const FLUSH_CHARS = 256 * 1024;

/**
 * Output retained per terminal for a view that attaches late - a reopened panel, a reload, a
 * switch back to the conversation (chars). Generous enough to refill the renderer's own
 * scrollback cap, and bounded so a shell left streaming in a closed panel costs nothing more.
 */
export const REPLAY_CHARS = 512 * 1024;

/**
 * Output below this is appended to the previous replay chunk rather than kept as its own: a shell
 * echoing keystrokes or a spinner writes a few bytes at a time, and trimming a buffer of
 * thousands of tiny chunks would shift the whole array on every write (chars).
 */
const REPLAY_COALESCE_CHARS = 4 * 1024;

/** Between hanging up on the shells at quit and killing what ignored it (ms). */
const SHUTDOWN_GRACE_MS = 2_000;

const MIN_DIMENSION = 2;
const MAX_DIMENSION = 1_000;

/** The slice of node-pty's IPty this uses, so tests can stand a fake in for it. */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type PtySpawn = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess;

/** A window that can be sent output. `WebContents` satisfies it. */
export interface TerminalReceiver {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

export interface TerminalManagerDeps {
  /** Resolved on first use, so an app that never opens a terminal never loads the native module. */
  loadSpawn(): Promise<PtySpawn>;
  /** The conversation's working directory (its worktree when it has one), or null for none. */
  workingDirectory(sessionId: string): Promise<string | null>;
  /** The login-shell PATH; see tools/userPath.ts. */
  userPath(): Promise<string>;
  home: string;
  shell: { file: string; args: string[] };
  /** Inherited by every shell before the overrides in terminalEnv. */
  baseEnv: NodeJS.ProcessEnv;
  locale?: string;
  platform?: NodeJS.Platform;
  /** One conversation's tab list changed; goes to every window. */
  changed(sessionId: string, terminals: TerminalInfo[]): void;
}

interface Live {
  info: TerminalInfo;
  pty: PtyProcess | null;
  listeners: { dispose(): void }[];
  replay: string[];
  replayChars: number;
  trimmed: boolean;
  pending: string;
  timer: ReturnType<typeof setTimeout> | null;
  receivers: Map<number, TerminalReceiver>;
  size: { cols: number; rows: number };
  /** Bumped by every `end`; a start that sees it change while it awaited does not spawn. */
  epoch: number;
}

type TrackedShell = {
  sessionId: string;
  pty: PtyProcess;
  exited: Promise<void>;
};

/**
 * The shell a terminal starts: the user's login shell, so their profile, prompt and PATH are
 * the ones they would get in any terminal app.
 */
export function defaultShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  userShell: string | null
): { file: string; args: string[] } {
  if (platform === 'win32') return { file: env.COMSPEC || 'powershell.exe', args: [] };
  return { file: env.SHELL || userShell || '/bin/zsh', args: ['-l'] };
}

/**
 * The environment a shell starts with.
 *
 * ELECTRON_* is dropped: ELECTRON_RUN_AS_NODE in particular would make any Electron app the user
 * launches from this terminal run as plain Node. LANG is filled in because a Finder-launched app
 * has none, and a shell without it draws every non-ASCII prompt glyph as escapes.
 */
export function terminalEnv(base: NodeJS.ProcessEnv, path: string, locale?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !key.startsWith('ELECTRON_')) env[key] = value;
  }
  env.PATH = path;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Bike4Mind';
  if (!env.LANG) {
    const match = /^([a-z]{2})[-_]([A-Z]{2})$/.exec(locale ?? '');
    env.LANG = match ? `${match[1]}_${match[2]}.UTF-8` : 'en_US.UTF-8';
  }
  return env;
}

function dimension(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.floor(value)));
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every pty the user has opened, keyed by terminal and owned by a conversation.
 *
 * Deliberately not reachable from ChatService or any tool: this is the user's keyboard, and the
 * agent neither reads its output nor types into it. Sessions end their terminals through the
 * service's `sessionClosed` notification, which carries an id and nothing back.
 *
 * Output is retained (bounded, see REPLAY_CHARS) whether or not anything is watching, and only
 * pushed to the windows attached to that terminal, batched per frame.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, Live>();
  /** Creates still awaiting their spawn, per session, so overlapping ones respect the cap. */
  private readonly starting = new Map<string, number>();
  /** Bumped per session by `killSession`, so a create in flight knows its session went. */
  private readonly sessionEpochs = new Map<string, number>();
  private readonly cleanupSessions = new Set<string>();
  private readonly shells = new Map<PtyProcess, TrackedShell>();
  private spawnFn: PtySpawn | null = null;

  constructor(private readonly deps: TerminalManagerDeps) {}

  list(sessionId: string): TerminalInfo[] {
    return [...this.terminals.values()].filter(live => live.info.sessionId === sessionId).map(live => live.info);
  }

  async create(sessionId: string, cols: unknown, rows: unknown): Promise<TerminalCreateResult> {
    if (this.cleanupSessions.has(sessionId)) return { ok: false, error: 'The conversation terminals are closing.' };
    const inFlight = this.starting.get(sessionId) ?? 0;
    if (this.list(sessionId).length + inFlight >= MAX_TERMINALS_PER_SESSION) {
      return { ok: false, error: `A conversation can have at most ${MAX_TERMINALS_PER_SESSION} terminals open.` };
    }
    const sessionEpoch = this.sessionEpochs.get(sessionId) ?? 0;
    const size = { cols: dimension(cols, 80), rows: dimension(rows, 24) };
    const id = randomUUID();
    const live: Live = {
      info: { id, sessionId, title: basename(this.deps.shell.file), cwd: '', generation: 0, exit: null },
      pty: null,
      listeners: [],
      replay: [],
      replayChars: 0,
      trimmed: false,
      pending: '',
      timer: null,
      receivers: new Map(),
      size,
      epoch: 0,
    };
    this.starting.set(sessionId, inFlight + 1);
    try {
      await this.start(live);
    } catch (err) {
      return { ok: false, error: `Could not start a shell: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      const left = (this.starting.get(sessionId) ?? 1) - 1;
      if (left > 0) this.starting.set(sessionId, left);
      else this.starting.delete(sessionId);
    }
    if ((this.sessionEpochs.get(sessionId) ?? 0) !== sessionEpoch) {
      this.end(live);
      return { ok: false, error: 'The conversation was closed.' };
    }
    this.terminals.set(id, live);
    this.announce(sessionId);
    return { ok: true, terminal: live.info };
  }

  /**
   * Start sending one terminal's output to `receiver`, and hand it what was printed before.
   *
   * Whatever is pending goes to the windows already attached first, so the snapshot and the
   * pushes after it neither overlap nor leave a gap.
   */
  attach(receiver: TerminalReceiver, terminalId: string): TerminalAttachment | null {
    const live = this.terminals.get(terminalId);
    if (!live) return null;
    this.flush(live);
    live.receivers.set(receiver.id, receiver);
    let replay = live.replay.join('');
    // A trimmed buffer starts mid-line, possibly mid escape sequence; the first whole line is
    // where a fresh screen can start parsing it cleanly.
    if (live.trimmed) {
      const newline = replay.indexOf('\n');
      replay = newline >= 0 ? replay.slice(newline + 1) : replay;
    }
    return { terminal: live.info, replay };
  }

  detach(receiverId: number, terminalId?: string): void {
    const targets = terminalId ? [this.terminals.get(terminalId)] : [...this.terminals.values()];
    for (const live of targets) live?.receivers.delete(receiverId);
  }

  write(terminalId: string, data: unknown): void {
    if (typeof data !== 'string' || data.length === 0) return;
    this.terminals.get(terminalId)?.pty?.write(data);
  }

  resize(terminalId: string, cols: unknown, rows: unknown): void {
    const live = this.terminals.get(terminalId);
    if (!live) return;
    live.size = { cols: dimension(cols, live.size.cols), rows: dimension(rows, live.size.rows) };
    try {
      live.pty?.resize(live.size.cols, live.size.rows);
    } catch {
      // The pty closed between the exit and this resize; the next start uses the stored size.
    }
  }

  async restart(terminalId: string): Promise<TerminalInfo | null> {
    const live = this.terminals.get(terminalId);
    if (!live || this.cleanupSessions.has(live.info.sessionId)) return null;
    this.end(live);
    // A view showing the old shell remounts on the new generation and attaches again; keeping
    // its registration would push it output that the new attach's replay also carries.
    live.receivers.clear();
    live.replay = [];
    live.replayChars = 0;
    live.trimmed = false;
    live.pending = '';
    live.info = { ...live.info, generation: live.info.generation + 1, exit: null };
    const epoch = live.epoch;
    try {
      await this.start(live);
    } catch (err) {
      if (live.epoch === epoch) {
        live.info = { ...live.info, exit: { code: -1, signal: null } };
        this.record(live, `\r\nCould not start a shell: ${err instanceof Error ? err.message : String(err)}\r\n`);
      }
    }
    // Closed meanwhile: its start stood down, and there is no tab left to announce.
    if (!this.terminals.has(terminalId)) return null;
    this.announce(live.info.sessionId);
    return live.info;
  }

  close(terminalId: string): void {
    const live = this.terminals.get(terminalId);
    if (!live || this.cleanupSessions.has(live.info.sessionId)) return;
    this.end(live);
    this.terminals.delete(terminalId);
    this.announce(live.info.sessionId);
  }

  /** Every terminal of a conversation that was archived or deleted. */
  killSession(sessionId: string): void {
    if (this.cleanupSessions.has(sessionId)) return;
    this.sessionEpochs.set(sessionId, (this.sessionEpochs.get(sessionId) ?? 0) + 1);
    const owned = [...this.terminals.values()].filter(live => live.info.sessionId === sessionId);
    if (owned.length === 0) return;
    for (const live of owned) {
      this.end(live);
      this.terminals.delete(live.info.id);
    }
    this.announce(sessionId);
  }

  /** Hold terminal creation closed until destructive workspace cleanup completes. */
  async acquireSessionCleanup(sessionId: string): Promise<() => void> {
    if (this.cleanupSessions.has(sessionId)) throw new Error('The conversation terminals are already closing.');
    this.cleanupSessions.add(sessionId);
    try {
      if (this.starting.get(sessionId)) throw new Error('A terminal is still starting. Try deleting again.');
      this.sessionEpochs.set(sessionId, (this.sessionEpochs.get(sessionId) ?? 0) + 1);
      const owned = [...this.terminals.values()].filter(live => live.info.sessionId === sessionId);
      for (const live of owned) live.epoch++;
      const running = [...this.shells.values()].filter(shell => shell.sessionId === sessionId);
      for (const shell of running) this.signalPty(shell.pty, 'SIGHUP');
      await this.waitForExits(running);
      for (const shell of running) if (this.shells.has(shell.pty)) this.signalPty(shell.pty, 'SIGKILL');
      await this.waitForExits(running);
      if (running.some(shell => this.shells.has(shell.pty))) {
        throw new Error('A terminal did not exit. Its worktree was kept.');
      }
      for (const live of owned) {
        this.end(live);
        this.terminals.delete(live.info.id);
      }
      this.announce(sessionId);
      return () => {
        this.cleanupSessions.delete(sessionId);
      };
    } catch (err) {
      this.cleanupSessions.delete(sessionId);
      throw err;
    }
  }

  runningCount(): number {
    return this.shells.size;
  }

  /**
   * Hang up on every shell, wait for them to go, and kill by pid whatever ignored the hangup.
   * The quit path's graceful pass; see main/index.ts.
   */
  async shutdown(): Promise<void> {
    const running = [...this.shells.values()];
    for (const shell of running) this.signalPty(shell.pty, 'SIGHUP');
    await this.waitForExits(running);
    for (const shell of running) if (this.shells.has(shell.pty)) this.signalPty(shell.pty, 'SIGKILL');
  }

  private async waitForExits(running: readonly TrackedShell[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>(resolve => {
      timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
    });
    try {
      await Promise.race([Promise.all(running.map(shell => shell.exited)), grace]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The quit path that cannot wait. A hangup only: the shell passes it on to its jobs, which a
   * SIGKILL sent straight after would stop it doing, and closing the pty as main exits hangs up
   * on the foreground job regardless.
   */
  shutdownSync(): void {
    for (const shell of this.shells.values()) this.signalPty(shell.pty, 'SIGHUP');
  }

  /** Throws when superseded: `end` ran (a restart, a close) while this was awaiting. */
  private async start(live: Live): Promise<void> {
    const epoch = live.epoch;
    this.spawnFn ??= await this.deps.loadSpawn();
    const wanted = await this.deps.workingDirectory(live.info.sessionId);
    // A worktree removed since, or a folder unmounted: the shell still opens, at home.
    const cwd = wanted && (await isDirectory(wanted)) ? wanted : this.deps.home;
    const env = terminalEnv(this.deps.baseEnv, await this.deps.userPath(), this.deps.locale);
    // A Finder launch has no SHELL, and tools run from the terminal read it to pick a shell.
    if (this.deps.platform !== 'win32') env.SHELL ||= this.deps.shell.file;
    if (live.epoch !== epoch) throw new Error('superseded');
    const pty = this.spawnFn(this.deps.shell.file, this.deps.shell.args, {
      name: 'xterm-256color',
      cols: live.size.cols,
      rows: live.size.rows,
      cwd,
      env,
    });
    live.pty = pty;
    live.info = { ...live.info, cwd };
    this.trackShell(live.info.sessionId, pty);
    live.listeners = [
      pty.onData(data => this.record(live, data)),
      pty.onExit(({ exitCode, signal }) => {
        if (live.pty !== pty) return;
        this.flush(live);
        live.pty = null;
        this.dispose(live);
        live.info = { ...live.info, exit: { code: exitCode, signal: signal || null } };
        if (this.terminals.has(live.info.id)) this.announce(live.info.sessionId);
      }),
    ];
  }

  private record(live: Live, data: string): void {
    const last = live.replay.length - 1;
    if (last >= 0 && live.replay[last].length < REPLAY_COALESCE_CHARS) live.replay[last] += data;
    else live.replay.push(data);
    live.replayChars += data.length;
    while (live.replayChars > REPLAY_CHARS && live.replay.length > 1) {
      live.replayChars -= live.replay.shift()!.length;
      live.trimmed = true;
    }
    if (live.replayChars > REPLAY_CHARS) {
      live.replay[0] = live.replay[0].slice(live.replayChars - REPLAY_CHARS);
      live.replayChars = REPLAY_CHARS;
      live.trimmed = true;
    }

    if (live.receivers.size === 0) return;
    live.pending += data;
    if (live.pending.length >= FLUSH_CHARS) {
      this.flush(live);
      return;
    }
    live.timer ??= setTimeout(() => this.flush(live), FLUSH_MS);
  }

  private flush(live: Live): void {
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
    if (!live.pending) return;
    const payload = { terminalId: live.info.id, data: live.pending };
    live.pending = '';
    for (const [id, receiver] of live.receivers) {
      if (receiver.isDestroyed()) {
        live.receivers.delete(id);
        continue;
      }
      receiver.send(IPC_CHANNELS.terminalData, payload);
    }
  }

  /** Stop listening and hang up. The exit that follows is not announced as this shell's own. */
  private end(live: Live): void {
    this.flush(live);
    const pty = live.pty;
    live.pty = null;
    this.dispose(live);
    if (pty) this.signalPty(pty, 'SIGHUP');
    live.epoch++;
  }

  private dispose(live: Live): void {
    for (const listener of live.listeners) listener.dispose();
    live.listeners = [];
  }

  /** Closed tabs can leave a shell alive; only the PTY exit event releases this handle. */
  private trackShell(sessionId: string, pty: PtyProcess): void {
    let markExited = () => {};
    const exited = new Promise<void>(resolve => {
      markExited = resolve;
    });
    this.shells.set(pty, { sessionId, pty, exited });
    const listener = pty.onExit(() => {
      this.shells.delete(pty);
      markExited();
      // Subscription implementations may report an already-exited shell synchronously.
      queueMicrotask(() => listener.dispose());
    });
  }

  private signalPty(pty: PtyProcess, signal: 'SIGHUP' | 'SIGKILL'): void {
    try {
      // node-pty's Windows backend throws on any named signal; its kill closes the console.
      if (this.deps.platform === 'win32') pty.kill();
      else pty.kill(signal);
    } catch {
      // Already gone.
    }
  }

  private announce(sessionId: string): void {
    this.deps.changed(sessionId, this.list(sessionId));
  }
}
