import { EventEmitter } from 'events';
import { ReplContext, type ReplToolMap, type ReplRunResult } from './ReplContext';
import type { ReplExecutor } from './replExecutor';
import { WorkerReplExecutor, type WorkerReplExecutorOptions } from './WorkerReplExecutor';
import { IsolatedVmExecutor, type IsolatedVmExecutorOptions } from './IsolatedVmExecutor';

/**
 * ReplSession owns one ReplContext for the lifetime of an agent session
 * and tracks per-session budget + usage. The agent loop creates one of
 * these on first `execute_code` call, reuses it for the rest of the
 * session, and disposes it when the agent retires.
 *
 * Budget guards exist because RLM-style trajectories can run away in the
 * tail - see the cost-variance discussion in
 * `apps/client/server/tavern/docs/07-PERSISTENT-REPL-TOOL.md`.
 *
 * Sub-LLM tool calls are tracked separately from code executions because
 * they're the dominant cost driver: a single `runCode` can fan out to
 * dozens of sub-LLM calls inside a `for` loop.
 */

export interface ReplSessionOptions {
  /** Stable identifier for this session (typically the agentSessionId). */
  sessionId: string;
  /** Optional human-readable label (for logs / observability). */
  label?: string;
  /** Per-runCode wall-clock cap. Default 30s. */
  perCallTimeoutMs?: number;
  /** Hard caps for budget enforcement. */
  budget?: {
    /** Max number of `runCode` invocations across the entire session. */
    maxExecutions?: number;
    /** Max number of sub-LLM calls. Tools that count themselves call `recordSubLlm()`. */
    maxSubLlmCalls?: number;
    /** Max accumulated USD spend on sub-LLM calls. */
    maxCostUsd?: number;
  };
  /**
   * Pick the execution backend.
   * - `'in-process'` (default): `vm.runInContext` in the main thread. Fast,
   *   no isolation. Good for tests + low-trust internal use.
   * - `'worker'` (Quest 3b): `worker_threads` with `resourceLimits` for memory
   *   caps and CPU isolation. Adds ~50-100ms startup per session; tool calls
   *   cost a postMessage round-trip. Right level for production-shape tavern
   *   use where the LLM code is still our own.
   * - `'isolated'` (Quest 3c): `isolated-vm` V8 isolate - a real trust
   *   boundary (separate heap, no shared object graph), not just resource
   *   isolation. Required before exposing `code_execute` to customer-facing /
   *   multi-tenant / third-party-LLM surfaces. Tool calls cross as a JSON
   *   round-trip.
   * - Custom `ReplExecutor` instance: pass your own backend. Use this for
   *   testing seams.
   *
   * If `executorOptions` is provided alongside `'worker'` or `'isolated'`,
   * those override the defaults (timeoutMs, resourceLimits / memoryLimitMb).
   */
  executor?: 'in-process' | 'worker' | 'isolated' | ReplExecutor;
  /**
   * Options forwarded to the resource-isolated backends. Applied when
   * `executor` is `'worker'` (WorkerReplExecutorOptions) or `'isolated'`
   * (IsolatedVmExecutorOptions). The two option shapes overlap on
   * `timeoutMs` / `label`; backend-specific keys are read by the matching
   * backend and ignored by the other.
   */
  executorOptions?: WorkerReplExecutorOptions & IsolatedVmExecutorOptions;
}

export interface ReplSessionUsage {
  executions: number;
  subLlmCalls: number;
  totalCostUsd: number;
  promptTokens: number;
  completionTokens: number;
  startedAt: number;
}

export class BudgetExceededError extends Error {
  constructor(reason: string) {
    super(`REPL session budget exceeded: ${reason}`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Quest 3a M3: structured observability events emitted by a ReplSession.
 * Consumers (tavern heartbeat, /api/opti/rlm-answer, future agents) can
 * subscribe to these to feed their existing logging / metrics pipelines.
 *
 * Each event carries the sessionId so a multi-agent process can route /
 * filter at the listener level. Timestamps are wall-clock (Date.now()).
 *
 * Listeners must be non-throwing. The session emits events fire-and-forget;
 * a thrown listener is swallowed to keep the agent loop running. Wrap your
 * own listener body in try/catch if you care about its errors.
 */
export interface ReplSessionEvents {
  /** Emitted just before runCode invokes the V8 context. */
  'code:start': (e: { sessionId: string; codeBytes: number; timestamp: number }) => void;
  /** Emitted after runCode completes (success or error). */
  'code:end': (e: {
    sessionId: string;
    durationMs: number;
    ok: boolean;
    error: string | null;
    truncated: boolean;
    stdoutBytes: number;
    timestamp: number;
  }) => void;
  /** Emitted after recordSubLlm. Counts include the just-recorded call. */
  'subllm:recorded': (e: {
    sessionId: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    cumulativeCalls: number;
    cumulativeCostUsd: number;
    timestamp: number;
  }) => void;
  /** Emitted whenever a budget cap fires (pre-flight or mid-execution). */
  'budget:exceeded': (e: {
    sessionId: string;
    reason: string;
    phase: 'preflight' | 'mid-execution';
    timestamp: number;
  }) => void;
}

/** Typed-EventEmitter shim so listeners get autocomplete on event names. */
interface TypedReplSessionEmitter {
  on<K extends keyof ReplSessionEvents>(event: K, listener: ReplSessionEvents[K]): this;
  off<K extends keyof ReplSessionEvents>(event: K, listener: ReplSessionEvents[K]): this;
  emit<K extends keyof ReplSessionEvents>(event: K, ...args: Parameters<ReplSessionEvents[K]>): boolean;

  removeAllListeners(event?: string): this;
}

export class ReplSession extends (EventEmitter as new () => TypedReplSessionEmitter) {
  readonly sessionId: string;
  readonly label: string;
  /**
   * The actual execution backend. Always implements the ReplExecutor
   * interface. For in-process mode this is a ReplContext; for worker mode
   * a WorkerReplExecutor; for custom backends, whatever the caller passed.
   *
   * `ctx` was the original name - kept as a readonly alias for
   * backward-compat with code that read `session.ctx.runCode(...)` directly.
   */
  readonly executor: ReplExecutor;
  readonly ctx: ReplExecutor; // alias for back-compat
  private usage: ReplSessionUsage = {
    executions: 0,
    subLlmCalls: 0,
    totalCostUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    startedAt: Date.now(),
  };
  private readonly budget: Required<NonNullable<ReplSessionOptions['budget']>>;
  /** Wall-clock timestamp of the most recent runCode or recordSubLlm. Used by
   * the registry's idle-TTL and LRU eviction logic. */
  private _lastAccessedAt: number = Date.now();

  get lastAccessedAt(): number {
    return this._lastAccessedAt;
  }

  /** Mark this session as accessed now. Called automatically on runCode /
   * recordSubLlm; callers can call it explicitly to keep an idle session
   * alive (e.g., a long-running heartbeat that hasn't yet executed code). */
  touch(): void {
    this._lastAccessedAt = Date.now();
  }

  constructor(opts: ReplSessionOptions) {
    super();
    this.sessionId = opts.sessionId;
    this.label = opts.label ?? `session:${opts.sessionId.slice(0, 8)}`;

    // Pick the execution backend per opts.executor (default: in-process).
    const executorChoice = opts.executor ?? 'in-process';
    if (executorChoice === 'in-process') {
      this.executor = new ReplContext({
        label: this.label,
        timeoutMs: opts.perCallTimeoutMs,
      });
    } else if (executorChoice === 'worker') {
      this.executor = new WorkerReplExecutor({
        label: this.label,
        timeoutMs: opts.perCallTimeoutMs,
        ...opts.executorOptions,
      });
    } else if (executorChoice === 'isolated') {
      this.executor = new IsolatedVmExecutor({
        label: this.label,
        timeoutMs: opts.perCallTimeoutMs,
        ...opts.executorOptions,
      });
    } else {
      // Caller passed a custom ReplExecutor instance
      this.executor = executorChoice;
    }
    this.ctx = this.executor; // back-compat alias

    this.budget = {
      maxExecutions: opts.budget?.maxExecutions ?? 25,
      maxSubLlmCalls: opts.budget?.maxSubLlmCalls ?? 200,
      maxCostUsd: opts.budget?.maxCostUsd ?? 10,
    };
  }

  /** Add or replace tools available in the REPL. */
  setTools(tools: ReplToolMap): void {
    this.executor.setTools(tools);
  }

  /** Release any resources held by the executor (worker thread, isolates). */
  async dispose(): Promise<void> {
    if (this.executor.dispose) await this.executor.dispose();
  }

  /**
   * Execute code in the persistent REPL. Throws BudgetExceededError if any
   * cap has been hit before the call (we check pre-flight so trajectories
   * fail fast rather than spending more on a doomed run).
   */
  async runCode(code: string): Promise<ReplRunResult & { sessionId: string }> {
    const reason = this.budgetReason();
    if (reason) {
      this.safeEmit('budget:exceeded', {
        sessionId: this.sessionId,
        reason,
        phase: 'preflight',
        timestamp: Date.now(),
      });
      throw new BudgetExceededError(reason);
    }

    this.usage.executions += 1;
    this._lastAccessedAt = Date.now();
    this.safeEmit('code:start', {
      sessionId: this.sessionId,
      codeBytes: code.length,
      timestamp: Date.now(),
    });

    const result = await this.executor.runCode(code);

    this.safeEmit('code:end', {
      sessionId: this.sessionId,
      durationMs: result.durationMs,
      ok: result.error === null,
      error: result.error,
      truncated: result.truncated,
      stdoutBytes: result.stdout.length,
      timestamp: Date.now(),
    });

    return { ...result, sessionId: this.sessionId };
  }

  /**
   * Record a sub-LLM call against the budget. Tools that fan out to
   * cheaper LLMs should call this so their cost is accounted for in the
   * session's totals.
   */
  recordSubLlm(opts: { costUsd: number; promptTokens?: number; completionTokens?: number }): void {
    this.usage.subLlmCalls += 1;
    this.usage.totalCostUsd += opts.costUsd;
    if (opts.promptTokens) this.usage.promptTokens += opts.promptTokens;
    if (opts.completionTokens) this.usage.completionTokens += opts.completionTokens;
    this._lastAccessedAt = Date.now();

    this.safeEmit('subllm:recorded', {
      sessionId: this.sessionId,
      promptTokens: opts.promptTokens ?? 0,
      completionTokens: opts.completionTokens ?? 0,
      costUsd: opts.costUsd,
      cumulativeCalls: this.usage.subLlmCalls,
      cumulativeCostUsd: this.usage.totalCostUsd,
      timestamp: Date.now(),
    });

    // Mid-execution budget enforcement: throw on the call that pushes the
    // session PAST the cap. The throw propagates out of the in-REPL tool
    // function (subAgentQuery) into the LLM-generated code, which either
    // catches it (agent gracefully wraps up) or lets it bubble out of
    // runCode (orchestrator stops the loop with budget error).
    //
    // Pre-flight check in runCode catches the case where budget was
    // already over before the next execute_code call. This mid-execution
    // check is for the case where a single execute_code spawns N
    // subAgentQuery calls in a tight loop and the (N+1)th pushes over.
    //
    // SEMANTICS:
    // - maxSubLlmCalls is interpreted strictly: with the cap at N, exactly
    //   N successful recordings complete cleanly; the (N+1)th throws.
    //   That's why we check `>` not `>=`.
    // - maxCostUsd is a hard ceiling - once total cost MEETS or exceeds
    //   the cap, the next recording throws (`>=`). This skews conservative
    //   on the spending side, which is the right posture for a $$ cap.
    //
    // NOTE: the throwing call's API result is lost (the caller of
    // recordSubLlm doesn't get to return its accumulated text). For the
    // call-count cap that's fine - by definition we authorized exactly
    // N successful calls. For the cost cap it means a small over-spend
    // (the (N+1)th call's API spend was already incurred) - accepted
    // tradeoff vs. continuously checking pre-flight.
    if (this.usage.subLlmCalls > this.budget.maxSubLlmCalls) {
      const reason = `sub-LLM calls ${this.usage.subLlmCalls}/${this.budget.maxSubLlmCalls}`;
      this.safeEmit('budget:exceeded', {
        sessionId: this.sessionId,
        reason,
        phase: 'mid-execution',
        timestamp: Date.now(),
      });
      throw new BudgetExceededError(`${reason} (mid-execution)`);
    }
    if (this.usage.totalCostUsd >= this.budget.maxCostUsd) {
      const reason = `cost $${this.usage.totalCostUsd.toFixed(4)}/$${this.budget.maxCostUsd}`;
      this.safeEmit('budget:exceeded', {
        sessionId: this.sessionId,
        reason,
        phase: 'mid-execution',
        timestamp: Date.now(),
      });
      throw new BudgetExceededError(`${reason} (mid-execution)`);
    }
  }

  /**
   * Emit an event with listener errors swallowed. The agent loop must keep
   * running even if a logging hook throws - observability is best-effort.
   */
  private safeEmit<K extends keyof ReplSessionEvents>(event: K, ...args: Parameters<ReplSessionEvents[K]>): void {
    try {
      this.emit(event, ...args);
    } catch {
      // Swallow listener errors. Consumers wanting to know about them
      // should wrap their listener body in try/catch.
    }
  }

  /** Snapshot of current usage. Caller-owned: mutate at your peril. */
  getUsage(): Readonly<ReplSessionUsage> {
    return { ...this.usage };
  }

  /** Names of variables currently defined in the REPL globals. */
  listGlobals(): string[] {
    return this.executor.listGlobals?.() ?? [];
  }

  /**
   * Check if any budget has been exceeded - for use after a runCode that
   * may have triggered sub-LLM tool calls. Returns null if all good, else
   * a human-readable reason.
   *
   * SEMANTICS: All three checks use `>=` against the *current* usage and
   * are evaluated PRE-INCREMENT in runCode. With cap=N this means:
   *   usage=N-1 -> check passes -> run -> usage=N (Nth call succeeds)
   *   usage=N   -> check fails  -> throw (N+1)th blocked
   * So the cap is "exactly N successful operations" - same end-state as
   * the post-increment `>` check used by recordSubLlm()'s mid-execution
   * enforcement, just expressed in the inverse convention.
   */
  budgetReason(): string | null {
    if (this.usage.executions >= this.budget.maxExecutions) {
      return `executions ${this.usage.executions}/${this.budget.maxExecutions}`;
    }
    if (this.usage.subLlmCalls >= this.budget.maxSubLlmCalls) {
      return `sub-LLM calls ${this.usage.subLlmCalls}/${this.budget.maxSubLlmCalls}`;
    }
    if (this.usage.totalCostUsd >= this.budget.maxCostUsd) {
      return `cost $${this.usage.totalCostUsd.toFixed(4)}/$${this.budget.maxCostUsd}`;
    }
    return null;
  }
}

/**
 * Process-wide cache of ReplSession instances keyed by sessionId. The
 * tavern heartbeat (and any other consumer) looks up sessions by
 * agentSessionId; this map is what the `execute_code` tool reads to
 * find the right context for the agent currently executing.
 *
 * Eviction policy (Quest 3a M1):
 * - **TTL**: sessions idle longer than `idleTtlMs` are evicted on the
 *   next `getOrCreateReplSession` call. Default 1 hour.
 * - **LRU cap**: registry holds at most `maxSessions` entries. When at
 *   the cap and a new session is requested, the least-recently-accessed
 *   session is evicted. Default 500.
 *
 * Both eviction paths are explicit - they only fire when
 * `getOrCreateReplSession` is called. There is no background timer.
 * That keeps eviction predictable and free of phantom side effects in
 * tests / Lambda cold-starts.
 */
interface RegistryConfig {
  /** Max sessions held in the registry. LRU evicts when over cap. */
  maxSessions: number;
  /** Idle threshold before TTL eviction (milliseconds). */
  idleTtlMs: number;
}

const sessionRegistry = new Map<string, ReplSession>();
// maxSessions sized for Lambda: a single warm Lambda holds at most a few
// concurrent agent runs, so 50 is generous headroom while bounding worker-
// thread memory (256MB x 50 = ~12.8GB worst case, realistically a fraction).
// Long-running server processes (tavern heartbeat host) can raise this via
// configureReplSessionRegistry().
let registryConfig: RegistryConfig = {
  maxSessions: 50,
  idleTtlMs: 60 * 60 * 1000, // 1 hour
};

/**
 * Tune the registry's eviction caps at runtime. Call this once at
 * process startup (or per-tenant if you want different policies).
 * Defaults are conservative for a single-host deployment.
 */
export function configureReplSessionRegistry(opts: Partial<RegistryConfig>): void {
  registryConfig = { ...registryConfig, ...opts };
}

export function getReplSessionRegistryConfig(): Readonly<RegistryConfig> {
  return { ...registryConfig };
}

/**
 * Walk the registry and drop sessions that haven't been accessed within
 * `idleTtlMs`. Returns the number of evictions.
 *
 * Exported so callers can run it on demand (e.g., a periodic cron in
 * the tavern, a healthcheck endpoint, etc.). Also called automatically
 * before each `getOrCreateReplSession` so the registry is self-healing.
 */
export function evictIdleReplSessions(now: number = Date.now()): number {
  const ttl = registryConfig.idleTtlMs;
  let evicted = 0;
  // Collect first, then dispose. Iterating-and-deleting in the same pass
  // is safe for Map but we also want to await each dispose() outside the
  // hot path so a slow worker termination doesn't block other evictions.
  const toEvict: ReplSession[] = [];
  for (const [id, session] of sessionRegistry) {
    if (now - session.lastAccessedAt > ttl) {
      sessionRegistry.delete(id);
      toEvict.push(session);
      evicted += 1;
    }
  }
  // Dispose fire-and-forget. We don't await: callers (getOrCreateReplSession,
  // healthchecks) are sync-ish and the worker terminate runs in the background.
  // Errors are swallowed because there's no caller to surface them to.
  for (const s of toEvict) safeDispose(s);
  return evicted;
}

/**
 * Drop the single least-recently-accessed session. Used internally when
 * the registry is at its cap and a new session is requested.
 *
 * Returns true if a session was evicted, false if the registry was empty.
 * The evicted session's `dispose()` is fired-and-forgotten - see
 * `evictIdleReplSessions` for the rationale.
 */
function evictLruReplSession(): boolean {
  let oldestId: string | null = null;
  let oldestTime = Infinity;
  for (const [id, session] of sessionRegistry) {
    if (session.lastAccessedAt < oldestTime) {
      oldestTime = session.lastAccessedAt;
      oldestId = id;
    }
  }
  if (oldestId) {
    const session = sessionRegistry.get(oldestId);
    sessionRegistry.delete(oldestId);
    if (session) safeDispose(session);
    return true;
  }
  return false;
}

export function getOrCreateReplSession(opts: ReplSessionOptions): ReplSession {
  const existing = sessionRegistry.get(opts.sessionId);
  if (existing) {
    existing.touch();
    return existing;
  }

  // Pre-insertion housekeeping: TTL sweep first, then LRU if still over cap.
  // Cheap given typical registry sizes (hundreds, not millions).
  evictIdleReplSessions();
  while (sessionRegistry.size >= registryConfig.maxSessions) {
    if (!evictLruReplSession()) break; // empty registry — defensive
  }

  const session = new ReplSession(opts);
  sessionRegistry.set(opts.sessionId, session);
  return session;
}

export function getReplSession(sessionId: string): ReplSession | undefined {
  const session = sessionRegistry.get(sessionId);
  if (session) session.touch();
  return session;
}

/**
 * Remove a session from the registry AND dispose its executor. Async because
 * worker-backed sessions need to await `worker.terminate()` for clean
 * shutdown. Callers that need fire-and-forget behavior can ignore the
 * returned promise.
 */
export async function disposeReplSession(sessionId: string): Promise<void> {
  const session = sessionRegistry.get(sessionId);
  sessionRegistry.delete(sessionId);
  if (session) await session.dispose();
}

export function activeReplSessionCount(): number {
  return sessionRegistry.size;
}

/**
 * Best-effort dispose helper for eviction paths that can't await. Worker
 * termination is async; we kick it off but don't block. Errors are
 * swallowed - eviction is a cleanup path, not a place to throw.
 */
function safeDispose(session: ReplSession): void {
  Promise.resolve(session.dispose()).catch(() => {
    // Eviction is best-effort - losing a worker on dispose is rare and
    // not actionable from the eviction path. The OS reclaims threads on
    // process exit if we ever leak past a normal session.
  });
}

/** Test-only: dispose any running executors, clear the registry, and reset
 * registry config to defaults. Awaits dispose so worker-backed sessions
 * cleanly shut down between test files (otherwise vitest hangs). */
export async function _resetReplSessionsForTests(): Promise<void> {
  const all = Array.from(sessionRegistry.values());
  sessionRegistry.clear();
  await Promise.allSettled(all.map(s => s.dispose()));
  registryConfig = {
    maxSessions: 50,
    idleTtlMs: 60 * 60 * 1000,
  };
}
