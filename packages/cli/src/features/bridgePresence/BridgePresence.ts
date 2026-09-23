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
import { resolveLoopbackListenerOwner } from './peerOwner.js';

/**
 * Local tavern presence for the B4M CLI.
 *
 * When `cc-bridge` is running on the same machine, the CLI announces itself
 * over loopback so it shows up as a sprite in the user's tavern (the
 * bridge is the sole tavern gateway - the CLI never opens its own Lumina5
 * WS). This module is fail-closed: when the bridge is absent the CLI runs
 * exactly as it does today, quietly retrying in the background. Only a foreign
 * port owner (a different-UID squatter) logs a one-time security warning; an
 * absent or undeterminable owner stays at debug so we don't cry wolf.
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
  /** Monotonic connection generation, bumped synchronously at the top of
   *  start() and stop() (before any await). Each awaited probe captures it and
   *  bails if it moved, so a stop()+start() cycle that completes while an older
   *  continuation is parked in checkPeerTrust() cannot re-announce, reconnect, or
   *  emit under the new generation's identity - an ABA the this.* null-checks
   *  miss (a fresh start() repopulates the very fields those checks test). */
  private generation = 0;
  /** Gate latch for the egress boundary. Opened only after a same-UID owner
   *  check passes for the current connection generation; `post()` refuses to
   *  put the secret on the wire while it is closed. Cleared when the command WS
   *  drops (the real TOCTOU boundary, where the port owner could flip). On
   *  teardown it is cleared last, AFTER stop()'s best-effort `/disconnect` -
   *  that POST rides the still-open gate deliberately: stop() only reaches it
   *  when the command WS is live to the peer we verified at connect (a flipped
   *  peer would have dropped the WS, closing the gate first). */
  private trusted = false;
  /** In-flight guard for connectCommandWs, scoped to the generation that owns
   *  it: the trust probe is awaited, so without this two overlapping calls could
   *  each build a socket and leave one untracked. Generation-scoped (not a bare
   *  boolean) so a stop()+start() landing inside a stale connect does not block
   *  the new generation's connect - only the same generation short-circuits. */
  private wsConnectingGen: number | null = null;
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
  /** Latch so the "untrusted peer" warning logs once per untrusted state, not
   *  on every backed-off announce/reconnect probe. Reset on a trusted check
   *  and in stop(). ponytail: a boolean latch, not a rate limiter. */
  private peerWarned = false;
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
    this.generation += 1; // new generation before any await; see `generation`
    const gen = this.generation;

    const config = await readBridgeConfig();
    // A stop()+start() during the config read supersedes this start(); bail so we
    // don't install a stale generation's config over the live one.
    if (gen !== this.generation) return false;
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

  /**
   * Classify the process holding the bridge port relative to this CLI, BEFORE
   * any secret leaves the process. Over loopback TCP the peer is whoever holds
   * the port; the secret file is plaintext and per-user, so a same-UID peer is
   * already trusted (it could read the file directly), and a different-UID (or
   * sandboxed) peer is the adversary this gate stops.
   *
   * Four outcomes, so the caller warns only on a real trust failure (a foreign
   * owner) and stays quiet on the benign ones:
   *  - `trusted`        - same-UID owner; disclosure is safe.
   *  - `absent`         - no loopback listener yet (cc-bridge simply not
   *                       started); fail-closed but quiet - just retry.
   *  - `foreign`        - a different-UID owner holds the port; fail-closed AND
   *                       log the security-worded warning (the real adversary).
   *  - `undeterminable` - ownership can't be resolved: unsupported platform
   *                       (getuid unavailable), lookup tool missing/hung, or an
   *                       ambiguous owner set. Fail-closed, but a host that can't
   *                       run the probe is not an attacker - log at debug, not as
   *                       the security warning.
   */
  private async checkPeerTrust(): Promise<'trusted' | 'absent' | 'foreign' | 'undeterminable'> {
    if (typeof process.getuid !== 'function') return 'undeterminable'; // Windows: uncheckable
    const port = this.config?.port ?? DEFAULT_PORT;
    let owner: Awaited<ReturnType<typeof resolveLoopbackListenerOwner>>;
    try {
      owner = await resolveLoopbackListenerOwner(port);
    } catch (err) {
      // An unexpected throw from the pure probe (a bug, not an expected failure it
      // classifies itself) - surface it at debug and fail closed rather than let
      // it reject up through start() and silently disable presence.
      logger.debug(`[tavern] loopback owner lookup threw: ${(err as Error).message}`);
      return 'undeterminable';
    }
    if (owner.kind === 'no-listener') return 'absent';
    if (owner.kind === 'unknown') return 'undeterminable';
    if (owner.uid !== process.getuid()) return 'foreign';
    this.peerWarned = false;
    return 'trusted';
  }

  /** Log the foreign-owner security warning once per untrusted state. */
  private warnUntrustedPeerOnce(): void {
    if (this.peerWarned) return;
    this.peerWarned = true;
    logger.warn('[tavern] bridge port is held by a different user; not disclosing secret or handling commands');
  }

  /** One announce attempt. Schedules a retry on failure; wires up the
   *  command WS + initial status on success. Idempotent: re-entering after
   *  a successful announce short-circuits at the instanceId guard. */
  private async attemptAnnounce(): Promise<boolean> {
    if (this.stopped || !this.config || !this.startOpts) return false;
    if (this.instanceId) return true;
    // A platform without getuid (Windows) can never pass the same-UID ownership
    // check, so every probe fails closed forever. Latch off rather than spin the
    // announce-retry loop at its 30s cap. Real Windows support would need a native
    // owner probe (e.g. GetExtendedTcpTable + process-token compare) - out of
    // scope for this loopback ownership fix.
    if (typeof process.getuid !== 'function') {
      logger.debug('[tavern] ownership unverifiable on this platform (no getuid); tavern presence disabled');
      return false;
    }
    const gen = this.generation;
    const startOpts = this.startOpts;

    // Verify the port owner before the secret leaves the process. An untrusted
    // squatter may be replaced by the real bridge later, so gateEgress routes
    // into the retry loop rather than latching offline. It also re-checks the
    // generation after its await, so a stop()+start() cycle can't slip through.
    if (!(await this.gateEgress(gen, 'announce'))) return false;

    const instanceId = uuidv4();
    const workspaceName = this.pendingWorkspaceName!;
    const capabilities = this.pendingCapabilities!;
    const source = this.pendingSource!;

    const announced = await this.announce({
      instanceId,
      source,
      workspaceName,
      workspacePath: startOpts.workspacePath,
      capabilities,
    });
    // Teardown, or a stop()+start() cycle, during the announce POST: bail
    // without publishing this superseded generation's instanceId.
    // ponytail: if the POST already registered the session before we bailed, that
    // instanceId is a short-lived ghost on the bridge - we never learned to
    // /disconnect it. Left to the bridge's own idle-session GC rather than
    // bypassing the ownership gate to disconnect a now-unverified peer.
    if (gen !== this.generation || this.stopped || !this.config) return false;
    if (!announced) {
      this.trusted = false;
      this.scheduleAnnounceRetry();
      return false;
    }

    this.instanceId = instanceId;
    this.announceAttempts = 0;
    logger.info(`[tavern] announced ${workspaceName} to cc-bridge on 127.0.0.1:${this.config.port ?? DEFAULT_PORT}`);
    void this.connectCommandWs().catch(err =>
      logger.debug(`[tavern] connectCommandWs threw: ${(err as Error).message}`)
    );
    // Initial status so the sprite doesn't sit at the default 'running'
    // forever if the user doesn't type anything - make it explicit.
    void this.emitEvent({ type: 'status', status: 'idle' }).catch(() => {
      /* emitEvent already logs its own failures */
    });
    return true;
  }

  /** Signal the untrusted condition at the right volume: the security-worded
   *  warning only for a real foreign owner, and a quiet debug line for the
   *  benign cases (bridge not started yet, or ownership undeterminable) so we
   *  don't cry wolf on every backed-off retry. */
  private signalUntrusted(trust: 'absent' | 'foreign' | 'undeterminable', phase: 'announce' | 'command WS'): void {
    if (trust === 'foreign') this.warnUntrustedPeerOnce();
    else if (trust === 'undeterminable') logger.debug(`[tavern] bridge port owner undeterminable; retrying ${phase}`);
    else logger.debug(`[tavern] cc-bridge not reachable yet; retrying ${phase}`);
  }

  /**
   * Run the pre-disclosure ownership gate for one egress phase and open or keep
   * the trust latch closed. The caller passes the connection `generation` it
   * captured BEFORE this await, so a stop()+start() cycle (or a bare stop())
   * landing during the probe is detected and this stale continuation bails.
   * Returns true iff the gate is open (secret disclosure is now permitted for
   * this generation); false means the caller must return - either the owner is
   * untrusted (a retry has been scheduled) or the generation moved.
   */
  private async gateEgress(gen: number, phase: 'announce' | 'command WS'): Promise<boolean> {
    const trust = await this.checkPeerTrust();
    if (gen !== this.generation || this.stopped || !this.config) return false;
    if (trust !== 'trusted') {
      this.trusted = false;
      this.signalUntrusted(trust, phase);
      if (phase === 'announce') this.scheduleAnnounceRetry();
      else this.scheduleReconnect();
      return false;
    }
    this.trusted = true; // gate open: post() / the WS URL may now carry the secret
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
      void this.attemptAnnounce().catch(err =>
        logger.debug(`[tavern] announce retry threw: ${(err as Error).message}`)
      );
    }, delay);
  }

  /** Emit an event for this session. No-op if the bridge isn't up. Events
   *  leave in strict order - see `emitQueue` comment. */
  async emitEvent(event: ICcAgentEventPayload): Promise<void> {
    if (!this.config || !this.instanceId) return;
    // Bind the identity at enqueue time: an event chained before a stop()+start()
    // cycle must post under the generation (and instanceId) that produced it, or
    // be dropped - never re-labelled with the new generation's identity.
    const instanceId = this.instanceId;
    const gen = this.generation;
    const task = () => {
      if (gen !== this.generation) return; // superseded by a stop()+start(); drop
      return this.post('/event', { instanceId, event }).catch(err =>
        // Logged at info (not debug) so the first-failure root cause surfaces
        // without flipping logger verbosity. The POST has a 2s timeout so this
        // won't spam on a flapping bridge.
        logger.info(`[tavern] emitEvent ${event.type} failed: ${(err as Error).message}`)
      );
    };
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
    this.generation += 1; // supersede any in-flight probe before any await
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
    this.peerWarned = false;
    this.trusted = false;
    // wsConnectingGen is intentionally NOT reset here: it is generation-scoped, so
    // a stale in-flight connect only short-circuits its own generation and clears
    // the flag in its own guarded `finally`. Clearing it here would either strand
    // the flag or (with a bare boolean) re-open the entry guard mid-probe.
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
    // The single egress boundary for every secret-bearing HTTP path
    // (/announce, /event, /disconnect). Refuse while the ownership gate is
    // closed so a peer that flipped after announce cannot be handed the secret.
    // Silent by design: the probe paths (attemptAnnounce / connectCommandWs)
    // already classify the owner and warn on a real foreign owner, so warning
    // again here would cry wolf on an ordinary bridge restart.
    if (!this.trusted) {
      throw new Error('bridge peer not trusted; refusing to disclose secret');
    }
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

  private async connectCommandWs(): Promise<void> {
    if (this.stopped || !this.config || !this.instanceId) return;
    const gen = this.generation;
    // Short-circuit only when connected, or already connecting for THIS
    // generation. A stale connect from a superseded generation must not block
    // this one, or a stop()+start() landing inside that stale probe would leave
    // the new session announced but with no inbound command channel.
    if (this.ws || this.wsConnectingGen === gen) return;
    this.wsConnectingGen = gen;
    try {
      // Re-verify ownership before the WS URL (which also carries the secret) is
      // built, and because its frames drive the callbacks. gateEgress covers
      // both callers - the announce-success path and the reconnect timer - and
      // re-checks the generation after its await.
      // ponytail: TOCTOU ceiling - owner is re-checked per connect to keep the
      // window small, but a rogue that kills the bridge and rebinds between this
      // check and connect could still be reached. A continuous guarantee needs
      // the server or an OS primitive; out of scope for a CLI-only fix.
      if (!(await this.gateEgress(gen, 'command WS'))) return;

      // gateEgress returned true, so the generation still matches and these are
      // set; the locals just re-narrow for TypeScript after the await.
      const config = this.config;
      const instanceId = this.instanceId;
      if (!config || !instanceId) return;

      const port = config.port ?? DEFAULT_PORT;
      const url = `ws://127.0.0.1:${port}/commands?instanceId=${encodeURIComponent(
        instanceId
      )}&secret=${encodeURIComponent(config.hookSecret)}`;

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        logger.debug(`[tavern] command WS construct failed: ${(err as Error).message}`);
        this.trusted = false;
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
        // Identity is the authoritative guard here: only the socket currently
        // tracked as ours may touch shared state. A socket from a superseded
        // generation (stop() closes the live socket, so its close resolves with
        // this.ws already reassigned or null) or an overlapping connect is inert
        // - it must not clear the live generation's trust latch or schedule a
        // spurious reconnect. This subsumes a generation check: a stale socket is
        // never the current this.ws.
        if (this.ws !== ws) return;
        this.ws = null;
        // Connection generation ended - re-verify ownership before the next
        // disclosure (the port owner could flip while we are disconnected).
        this.trusted = false;
        if (this.stopped) return;
        logger.debug('[tavern] command WS closed; reconnecting');
        this.scheduleReconnect();
      });

      ws.on('error', err => {
        logger.debug(`[tavern] command WS error: ${(err as Error).message}`);
        // `close` will follow; reconnect there.
      });
    } finally {
      // Only clear the flag if this call still owns it. A later generation may
      // have taken it over while this stale call was parked in the probe; its
      // own finally will clear it.
      if (this.wsConnectingGen === gen) this.wsConnectingGen = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    // Short, capped backoff - bridge is local, reconnects should feel instant.
    const delay = Math.min(500 * 2 ** (this.reconnectAttempts - 1), 10_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectCommandWs().catch(err =>
        logger.debug(`[tavern] command WS reconnect threw: ${(err as Error).message}`)
      );
    }, delay);
  }

  private async dispatchCommand(command: ICcAgentCommandPayload): Promise<void> {
    if (this.stopped) return; // a frame may arrive between stop() and socket close
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
