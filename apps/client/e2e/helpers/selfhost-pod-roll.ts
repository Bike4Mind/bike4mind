import { spawn } from 'node:child_process';
import { type Page, type WebSocket } from '@playwright/test';

/**
 * Support for selfhost-pod-roll.spec.ts: the operator-supplied pod roll commands and a record of
 * the page's realtime sockets. Kept free of app imports so the tracker can be exercised against
 * the gateway alone.
 */

export interface PodRollEnv {
  /** Shell command that replaces the app pod and returns once the replacement serves requests. */
  appRollCommand: string;
  /** Same, for the WebSocket gateway pod. */
  wsRollCommand: string;
  /** Budget for one roll command (ms). */
  rollTimeoutMs: number;
  /** Budget for the client to be back on a working socket after a roll (ms). */
  reconnectTimeoutMs: number;
}

const DEFAULT_ROLL_TIMEOUT_MS = 300_000;
// WebsocketContext gives up after 20 attempts (about 6 minutes of backoff); stay inside that.
const DEFAULT_RECONNECT_TIMEOUT_MS = 180_000;

function positiveMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of milliseconds`);
  return value;
}

/** Throws rather than skipping: a skipped run of this check would read as a pass. */
export function readPodRollEnv(): PodRollEnv {
  const appRollCommand = process.env.SELFHOST_ROLL_APP_CMD?.trim();
  const wsRollCommand = process.env.SELFHOST_ROLL_WS_CMD?.trim();
  const missing = [
    !process.env.API_URL && 'API_URL',
    !process.env.E2E_CLEANUP_SECRET && 'E2E_CLEANUP_SECRET',
    !appRollCommand && 'SELFHOST_ROLL_APP_CMD',
    !wsRollCommand && 'SELFHOST_ROLL_WS_CMD',
  ].filter(Boolean);
  if (missing.length || !appRollCommand || !wsRollCommand) {
    throw new Error(
      `The pod roll check needs ${missing.join(', ')}. See "Pod roll reconnect check" in selfhost/kubernetes/README.md.`
    );
  }
  return {
    appRollCommand,
    wsRollCommand,
    rollTimeoutMs: positiveMs('SELFHOST_ROLL_TIMEOUT_MS', DEFAULT_ROLL_TIMEOUT_MS),
    reconnectTimeoutMs: positiveMs('SELFHOST_RECONNECT_TIMEOUT_MS', DEFAULT_RECONNECT_TIMEOUT_MS),
  };
}

/**
 * Run one operator-supplied roll command through the shell, with its output in the test log.
 * Rejects on a non-zero exit or when the budget runs out. The command text is never logged: it
 * comes from the operator's environment and may name their cluster.
 */
export function runRollCommand(label: string, command: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // detached: the command gets its own process group, so the timeout can stop a pipeline or a
    // kubectl child and not just the shell.
    const child = spawn(command, { shell: true, stdio: 'inherit', detached: true });
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      reject(new Error(`${label} roll command did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`${label} roll command could not start: ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${label} roll command failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
}

export interface TrackedSocket {
  /** 1-based order in which the page created its realtime sockets. */
  id: number;
  createdAt: number;
  closedAt: number | null;
  /** Null until the first frame arrives; a socket whose handshake failed never gets one. */
  lastFrameAt: number | null;
  /** Arrival times of streamed_chat_completion frames. */
  streamFrameTimes: number[];
}

// The browser client authenticates each connect with a single-use ticket (WebsocketContext
// getWebsocketUrl), which is what tells the realtime socket apart from any other the page opens.
const isRealtimeSocketUrl = (url: string) => /[?&]ticket=/.test(url);

const STREAM_FRAME_MARKER = '"action":"streamed_chat_completion"';

/**
 * Records every realtime socket the page creates. Playwright reports a socket when it is
 * constructed, before the handshake, so "created" proves nothing: only a received frame shows the
 * gateway accepted the connection. The gateway answers the client heartbeat (every 15s) with a
 * 'pong' frame, so a healthy idle socket still produces one.
 */
export class RealtimeSocketTracker {
  readonly sockets: TrackedSocket[] = [];

  constructor(page: Page) {
    page.on('websocket', (ws: WebSocket) => {
      if (!isRealtimeSocketUrl(ws.url())) return;
      const record: TrackedSocket = {
        id: this.sockets.length + 1,
        createdAt: Date.now(),
        closedAt: null,
        lastFrameAt: null,
        streamFrameTimes: [],
      };
      this.sockets.push(record);
      ws.on('framereceived', ({ payload }) => {
        const now = Date.now();
        record.lastFrameAt = now;
        if (typeof payload === 'string' && payload.includes(STREAM_FRAME_MARKER)) record.streamFrameTimes.push(now);
      });
      ws.on('close', () => {
        record.closedAt = Date.now();
      });
    });
  }

  /** The open socket that most recently carried a frame after `since`, if any. */
  liveSince(since: number): TrackedSocket | undefined {
    return this.sockets
      .filter(s => s.closedAt === null && s.lastFrameAt !== null && s.lastFrameAt > since)
      .sort((a, b) => (b.lastFrameAt ?? 0) - (a.lastFrameAt ?? 0))[0];
  }

  /** An open socket created after `since` that has carried a frame: a completed reconnect. */
  reconnectedSince(since: number): TrackedSocket | undefined {
    return this.sockets.find(s => s.createdAt > since && s.closedAt === null && s.lastFrameAt !== null);
  }

  /** Stream frames that arrived after `since`, on sockets created after `createdAfter`. */
  streamFramesSince(since: number, createdAfter = 0): number {
    return this.sockets
      .filter(s => s.createdAt > createdAfter)
      .reduce((total, s) => total + s.streamFrameTimes.filter(t => t > since).length, 0);
  }

  /** One line per socket for a failure message. Carries no URL, so no ticket. */
  describe(): string {
    if (!this.sockets.length) return 'no realtime socket was created';
    return this.sockets
      .map(
        s =>
          `#${s.id} created=${new Date(s.createdAt).toISOString()} ` +
          `closed=${s.closedAt ? new Date(s.closedAt).toISOString() : 'no'} ` +
          `lastFrame=${s.lastFrameAt ? new Date(s.lastFrameAt).toISOString() : 'never'} ` +
          `streamFrames=${s.streamFrameTimes.length}`
      )
      .join('; ');
  }
}
