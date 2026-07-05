import { promises as fs } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import type {
  ICcAgentCapability,
  ICcAgentCommandPayload,
  ICcAgentEventPayload,
  ICcAgentSource,
} from '@bike4mind/common';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/Logger.js';

/**
 * Local tavern presence for the B4M CLI.
 *
 * When `cc-bridge` is running on the same machine, the CLI announces itself
 * over loopback so it shows up as a sprite in the user's tavern (the
 * bridge is the sole tavern gateway - the CLI never opens its own Lumina5
 * WS). When the bridge is absent, this module is a strict no-op: the CLI
 * runs exactly as it does today with one warning logged at startup.
 *
 * Wire protocol (see `cc-bridge/src/http.ts` in the b4m-tavern overlay repo):
 *  - `POST /announce?secret=<s>` -> register a session
 *  - `POST /event?secret=<s>` -> push an event
 *  - `POST /disconnect?secret=<s>` -> signal session end
 *  - `ws://127.0.0.1:<port>/commands?instanceId=<i>&secret=<s>` -> inbound
 *    commands pushed as JSON `{ requestId, command }` frames
 */

interface BridgeConfig {
  port?: number;
  hookSecret: string;
}

const DEFAULT_PORT = Number(process.env.CC_BRIDGE_PORT ?? 48732);
const CONFIG_PATH = join(homedir(), '.b4m', 'cc-bridge.json');
const ANNOUNCE_TIMEOUT_MS = 2_000;

async function readBridgeConfig(): Promise<BridgeConfig | null> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BridgeConfig>;
    if (typeof parsed.hookSecret !== 'string' || !parsed.hookSecret) return null;
    return {
      port: typeof parsed.port === 'number' ? parsed.port : DEFAULT_PORT,
      hookSecret: parsed.hookSecret,
    };
  } catch {
    return null;
  }
}

export interface StartOptions {
  workspacePath: string;
  workspaceName?: string;
  capabilities?: ICcAgentCapability[];
  source?: ICcAgentSource;
}

export interface BridgePresenceCallbacks {
  /** Tavern user submitted a prompt - pipe into the CLI's `handleMessage`. */
  onSendPrompt?: (text: string) => void | Promise<void>;
  /** Tavern user answered a permission prompt. */
  onResolvePermission?: (requestId: string, allow: boolean) => void | Promise<void>;
  /** Tavern user clicked Abort. */
  onAbort?: () => void | Promise<void>;
}

interface ServerCommandFrame {
  requestId?: string;
  command?: ICcAgentCommandPayload;
}

export class BridgePresence {
  private config: BridgeConfig | null = null;
  private instanceId: string | null = null;
  private ws: WebSocket | null = null;
  private callbacks: BridgePresenceCallbacks = {};
  private started = false;
  private stopped = false;
  /** Backoff state for the command WS. Capped low - bridge is on the same
   *  machine, so reconnect latency matters. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  /** Backoff state for the initial POST /announce. The bridge may be
   *  starting after the CLI; without retry, a single missed probe would
   *  latch the sprite offline for the life of the CLI process. */
  private announceRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private announceAttempts = 0;
  /** Cached start() inputs so the retry loop can announce without the caller
   *  having to re-invoke start(). Written once; never reassigned. */
  private startOpts: StartOptions | null = null;
  private pendingWorkspaceName: string | null = null;
  private pendingCapabilities: ICcAgentCapability[] | null = null;
  private pendingSource: ICcAgentSource | null = null;
  /**
   * Strict-ordered emit queue. Each `emitEvent` chains onto this so the
   * POST `/event` calls leave the CLI in the same order the caller invoked
   * them. Without this, `void bridgePresence.emitEvent(...)` calls race at
   * the network layer and the transcript can show e.g. `idle` before the
   * assistant message that caused it (both have sub-ms `createdAt` on the
   * server, so strict Mongo ordering is a dice roll under load).
   *
   * Trade-off: every emit waits for the previous one's POST ack. On
   * localhost that's sub-ms; the ordering win is worth it. If we ever
   * need to fan-out events to multiple sinks, swap this for per-sink
   * queues rather than losing the ordering guarantee globally.
   */
  private emitQueue: Promise<void> = Promise.resolve();

  setCallbacks(cbs: BridgePresenceCallbacks): void {
    this.callbacks = cbs;
  }

  /**
   * Probe the local bridge and, if present, announce this CLI session.
   * Returns true iff the announce succeeded (tavern presence is active).
   * Safe to call multiple times - second call no-ops.
   *
   * If announce fails (bridge absent or not yet up), a background retry
   * loop keeps trying with bounded backoff so the sprite appears when the
   * bridge comes online later in the CLI's lifetime.
   */
  async start(opts: StartOptions): Promise<boolean> {
    if (this.started) return this.instanceId !== null;
    // Clear any latched teardown from a prior stop() so the singleton can be
    // toggled off (Tavern feature disabled) and back on within one CLI run.
    this.stopped = false;
    this.started = true;

    const config = await readBridgeConfig();
    if (!config) {
      logger.debug('[tavern] cc-bridge not configured; CLI runs without tavern presence');
      return false;
    }
    this.config = config;
    this.startOpts = opts;
    this.pendingWorkspaceName = opts.workspaceName ?? (basename(opts.workspacePath) || 'workspace');
    this.pendingCapabilities = opts.capabilities ?? ['interactive'];
    this.pendingSource = opts.source ?? 'b4m-cli';

    return this.attemptAnnounce();
  }

  /** One announce attempt. Schedules a retry on failure; wires up the
   *  command WS + initial status on success. Idempotent: re-entering after
   *  a successful announce short-circuits at the instanceId guard. */
  private async attemptAnnounce(): Promise<boolean> {
    if (this.stopped || !this.config || !this.startOpts) return false;
    if (this.instanceId) return true;

    const instanceId = uuidv4();
    const workspaceName = this.pendingWorkspaceName!;
    const capabilities = this.pendingCapabilities!;
    const source = this.pendingSource!;

    const announced = await this.announce({
      instanceId,
      source,
      workspaceName,
      workspacePath: this.startOpts.workspacePath,
      capabilities,
    });
    if (!announced) {
      this.scheduleAnnounceRetry();
      return false;
    }

    this.instanceId = instanceId;
    this.announceAttempts = 0;
    logger.info(`[tavern] announced ${workspaceName} to cc-bridge on 127.0.0.1:${this.config.port ?? DEFAULT_PORT}`);
    this.connectCommandWs();
    // Initial status so the sprite doesn't sit at the default 'running'
    // forever if the user doesn't type anything - make it explicit.
    void this.emitEvent({ type: 'status', status: 'idle' });
    return true;
  }

  private scheduleAnnounceRetry(): void {
    if (this.stopped || this.announceRetryTimer) return;
    this.announceAttempts += 1;
    // Longer cap than the WS reconnect - a missing bridge is probably
    // waiting on the user to launch it, not a flapping socket. First few
    // retries are quick so the sprite appears soon after the user runs
    // cc-bridge; tail caps at 30s so we don't hammer the localhost port
    // indefinitely in the bridge-never-starts case.
    const delay = Math.min(1000 * 2 ** (this.announceAttempts - 1), 30_000);
    this.announceRetryTimer = setTimeout(() => {
      this.announceRetryTimer = null;
      void this.attemptAnnounce();
    }, delay);
  }

  /** Emit an event for this session. No-op if the bridge isn't up. Events
   *  leave in strict order - see `emitQueue` comment. */
  async emitEvent(event: ICcAgentEventPayload): Promise<void> {
    if (!this.config || !this.instanceId) return;
    const task = () =>
      this.post('/event', { instanceId: this.instanceId, event }).catch(err =>
        // Logged at info (not debug) so the first-failure root cause surfaces
        // without flipping logger verbosity. The POST has a 2s timeout so this
        // won't spam on a flapping bridge.
        logger.info(`[tavern] emitEvent ${event.type} failed: ${(err as Error).message}`)
      );
    // Use `finally` flavor of chaining: a failed emit must not stall the
    // rest of the queue. `this.emitQueue.then(task, task)` swallows the
    // prior rejection and runs `task` regardless.
    this.emitQueue = this.emitQueue.then(task, task);
    return this.emitQueue;
  }

  /**
   * Tear down the tavern presence cleanly. Halts the announce-retry and
   * command-WS reconnect loops, closes the socket, and best-effort signals
   * disconnect to the bridge.
   *
   * After this resolves the instance is fully reset, so a later `start()`
   * re-announces - the same singleton can be toggled off (Tavern feature
   * disabled at runtime) and back on without restarting the CLI. The
   * `stopped` latch is left true here purely so any straggler retry callback
   * already queued short-circuits; `start()` clears it.
   */
  async stop(reason = 'cli_exit'): Promise<void> {
    if (this.stopped || !this.started) return;
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.announceRetryTimer) {
      clearTimeout(this.announceRetryTimer);
      this.announceRetryTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    if (this.config && this.instanceId) {
      await this.post('/disconnect', { instanceId: this.instanceId, reason }).catch(() => {
        /* best-effort */
      });
    }
    // Reset identity so a future start() re-announces rather than
    // short-circuiting at the `this.started` guard.
    this.started = false;
    this.instanceId = null;
    this.config = null;
    this.startOpts = null;
    this.pendingWorkspaceName = null;
    this.pendingCapabilities = null;
    this.pendingSource = null;
    this.announceAttempts = 0;
    this.reconnectAttempts = 0;
    // Reset the strict-ordered emit queue so a restart within the same CLI run
    // doesn't chain its first event onto a settled/failed promise from the
    // prior session (which could delay or reorder startup events).
    this.emitQueue = Promise.resolve();
  }

  private async announce(body: {
    instanceId: string;
    source: ICcAgentSource;
    workspaceName: string;
    workspacePath: string;
    capabilities: ICcAgentCapability[];
  }): Promise<boolean> {
    try {
      await this.post('/announce', body);
      return true;
    } catch (err) {
      logger.info(`[tavern] bridge announce failed: ${(err as Error).message}`);
      return false;
    }
  }

  private async post(path: string, body: unknown): Promise<void> {
    if (!this.config) throw new Error('bridge config not loaded');
    const port = this.config.port ?? DEFAULT_PORT;
    const url = `http://127.0.0.1:${port}${path}?secret=${encodeURIComponent(this.config.hookSecret)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ANNOUNCE_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`bridge ${path} -> ${res.status}`);
    }
  }

  private connectCommandWs(): void {
    if (this.stopped || !this.config || !this.instanceId) return;

    const port = this.config.port ?? DEFAULT_PORT;
    const url = `ws://127.0.0.1:${port}/commands?instanceId=${encodeURIComponent(
      this.instanceId
    )}&secret=${encodeURIComponent(this.config.hookSecret)}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      logger.debug(`[tavern] command WS construct failed: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempts = 0;
      logger.debug('[tavern] command WS open');
    });

    ws.on('message', raw => {
      let frame: ServerCommandFrame | null = null;
      try {
        frame = JSON.parse(raw.toString()) as ServerCommandFrame;
      } catch {
        logger.debug('[tavern] malformed command frame; ignored');
        return;
      }
      if (!frame?.command) return;
      void this.dispatchCommand(frame.command).catch(err =>
        logger.warn(`[tavern] command dispatch threw: ${(err as Error).message}`)
      );
    });

    ws.on('close', () => {
      this.ws = null;
      if (this.stopped) return;
      logger.debug('[tavern] command WS closed; reconnecting');
      this.scheduleReconnect();
    });

    ws.on('error', err => {
      logger.debug(`[tavern] command WS error: ${(err as Error).message}`);
      // `close` will follow; reconnect there.
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    // Short, capped backoff - bridge is local, reconnects should feel instant.
    const delay = Math.min(500 * 2 ** (this.reconnectAttempts - 1), 10_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectCommandWs();
    }, delay);
  }

  private async dispatchCommand(command: ICcAgentCommandPayload): Promise<void> {
    switch (command.type) {
      case 'send_prompt':
        if (this.callbacks.onSendPrompt) await this.callbacks.onSendPrompt(command.text);
        break;
      case 'resolve_permission':
        if (this.callbacks.onResolvePermission) {
          await this.callbacks.onResolvePermission(command.requestId, command.allow);
        }
        break;
      case 'abort':
        if (this.callbacks.onAbort) await this.callbacks.onAbort();
        break;
    }
  }
}

/** Process-wide singleton - the CLI only ever has one tavern presence per run. */
export const bridgePresence = new BridgePresence();
