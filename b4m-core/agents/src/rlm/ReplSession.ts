import { EventEmitter } from 'events';
import { Logger } from '@bike4mind/observability';
import { ReplContext, type ReplToolMap, type ReplRunResult } from './ReplContext';
import { replExecutorNameList, type ReplExecutor, type ReplExecutorName } from './replExecutor';
import { WorkerReplExecutor, type WorkerReplExecutorOptions } from './WorkerReplExecutor';
import { IsolatedVmExecutor, type IsolatedVmExecutorOptions } from './IsolatedVmExecutor';

/**
 * ReplSession owns one ReplExecutor for the lifetime of an agent session
 * and tracks per-session budget + usage. Which executor - and so how much
 * isolation the guest code gets - is the caller's explicit choice; see
 * `ReplSessionOptions.executor`. The agent loop creates one of
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

/**
 * How a ReplSession gets its execution backend: a built-in backend by name,
 * or a caller-supplied `ReplExecutor`. See `ReplSessionOptions.executor` for
 * what each name costs you in isolation.
 */
export type ReplExecutorChoice = ReplExecutorName | ReplExecutor;

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
    /** Max number of sub-LLM calls. Tools claim against this with `reserveSubLlm()`. */
    maxSubLlmCalls?: number;
    /** Max accumulated USD spend on sub-LLM calls. */
    maxCostUsd?: number;
  };
  /**
   * Pick the execution backend. REQUIRED - there is deliberately no default.
   *
   * The backend IS the trust boundary, so the choice belongs to the caller
   * who knows where the code came from. This option used to default to
   * `'in-process'`, which silently gave every caller an escapable sandbox;
   * a caller that forgets to choose must now fail to compile, not fail open.
   *
   * - `'isolated'`: `isolated-vm` V8 isolate - a real trust boundary
   *   (separate heap, no shared object graph). The ONLY backend that may run
   *   code authored by an LLM, an end user, or anyone else outside the
   *   deploy. Tool calls cross as a JSON round-trip.
   * - `'worker'`: `worker_threads` with `resourceLimits`. Gives memory + CPU
   *   isolation and lets a runaway run be force-terminated, but it is NOT a
   *   trust boundary: the guest runs under `node:vm` inside the worker, and
   *   `vm` shares the worker's realm, so guest code can reach the worker's
   *   own `process` / `require` through a `constructor` chain. Use for
   *   OUR OWN code that we want resource-capped.
   * - `'in-process-unsafe'`: `vm.runInContext` on the main thread. NOT a
   *   sandbox of any kind - guest code reaches the host realm's `Function`
   *   constructor through any injected intrinsic or tool closure and from
   *   there `process.env` and host `fetch`, in the process holding the
   *   platform's credentials. Fast and dependency-free, which makes it right
   *   for unit tests over code the test itself wrote, and wrong for
   *   everything else. Named to be unmistakable at the call site.
   * - Custom `ReplExecutor` instance: pass your own backend. Use this for
   *   testing seams.
   *
   * If `executorOptions` is provided alongside `'worker'` or `'isolated'`,
   * those override the defaults (timeoutMs, resourceLimits / memoryLimitMb).
   */
  executor: ReplExecutorChoice;
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

/**
 * A claim on the session's sub-LLM budget, taken out BEFORE the provider
 * request is dispatched. Exactly one of `settle` / `release` must be called;
 * both are idempotent, and later calls are ignored.
 */
export interface SubLlmReservation {
  /** Swap the reserved estimate for the real cost once the call returns. */
  settle(actual: { costUsd: number; promptTokens?: number; completionTokens?: number }): void;
  /** Give the reservation back - the call never reached the provider. */
  release(): void;
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

/**
 * Structural check for a caller-supplied backend. Both members of the
 * `ReplExecutor` contract that ReplSession actually calls must be present -
 * `listGlobals` / `dispose` are optional in the interface, so they are not
 * part of the test.
 */
function isReplExecutor(v: unknown): v is ReplExecutor {
  if (typeof v !== 'object' || v === null) return false;
  const candidate = v as Partial<ReplExecutor>;
  return typeof candidate.setTools === 'function' && typeof candidate.runCode === 'function';
}

/** Describe a rejected `executor` value for the error message, without
 *  stringifying a whole object into it. */
function describeExecutorValue(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'object') {
    const name = (v as object).constructor?.name ?? 'Object';
    return `a ${name} with no setTools/runCode`;
  }
  return `${typeof v} ${JSON.stringify(v)}`;
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
  /**
   * Which backend the constructing caller asked for ('custom' for a
   * caller-supplied instance). Kept so registry reuse can refuse to hand a
   * caller a session running a backend it did not ask for - see
   * `getOrCreateReplSession`.
   */
  readonly executorChoice: ReplExecutorName | 'custom';
  private usage: ReplSessionUsage = {
    executions: 0,
    subLlmCalls: 0,
    totalCostUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    startedAt: Date.now(),
  };
  private readonly budget: Required<NonNullable<ReplSessionOptions['budget']>>;
  /**
   * Estimated spend on sub-LLM calls that are dispatched but not yet
   * settled. Held apart from `usage.totalCostUsd` (which only ever holds
   * real, returned costs) so `getUsage()` stays a truthful record of actual
   * spend while the caps still see money that is already committed.
   */
  private reservedCostUsd = 0;
  /**
   * The session-shaping options this session was BUILT with, kept verbatim so
   * a later `getOrCreateReplSession` with the same id can tell a caller asking
   * for something different from one asking for the same thing again. Read
   * only by `warnOnDivergentReuse`; the live values live in `this.budget` and
   * inside the executor.
   */
  private readonly shapingOptions: Pick<ReplSessionOptions, (typeof REUSE_IGNORED_OPTION_KEYS)[number]>;
  /** Wall-clock timestamp of the most recent runCode or recordSubLlm. Used by
   * the registry's idle-TTL and LRU eviction logic. */
  private _lastAccessedAt: number = Date.now();

  get lastAccessedAt(): number {
    return this._lastAccessedAt;
  }

  /** What this session was constructed with - see `warnOnDivergentReuse`. */
  get configuredShapingOptions(): Readonly<Pick<ReplSessionOptions, (typeof REUSE_IGNORED_OPTION_KEYS)[number]>> {
    return this.shapingOptions;
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

    // Pick the execution backend per opts.executor. No default: an
    // unspecified backend is a caller bug, not a cue to pick the fast one.
    const executorChoice = opts.executor;
    if (executorChoice === 'in-process-unsafe') {
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
    } else if (typeof executorChoice === 'string') {
      // TypeScript keeps in-repo callers honest, but out-of-repo JS consumers
      // are not typechecked - and the rename this major forces ('in-process' ->
      // 'in-process-unsafe') is exactly the string they would still be passing.
      // Falling through to the custom-instance branch would defer the failure to
      // `this.executor.setTools is not a function`, which names neither the
      // rename nor the backend. The whole point of this option is that the
      // backend choice is unmistakable, so say so here.
      throw new Error(
        `ReplSession: unknown executor "${executorChoice}" - expected ${replExecutorNameList()} ` +
          `or a ReplExecutor instance`
      );
    } else if (isReplExecutor(executorChoice)) {
      // Caller passed a custom ReplExecutor instance
      this.executor = executorChoice;
    } else {
      // Omitted, null, or some other non-executor value. TypeScript makes this
      // unreachable in-repo, but an out-of-repo JS consumer that simply never
      // passed `executor` (the pre-rename shape, where it defaulted) lands
      // here - and used to fall through to the branch above, assigning
      // `undefined` and deferring the failure to a bare `Cannot read
      // properties of undefined (reading 'setTools')` with nothing in it about
      // the option that was missing.
      throw new Error(
        `ReplSession: \`executor\` is required and must be ${replExecutorNameList()} ` +
          `or a ReplExecutor instance (got ${describeExecutorValue(executorChoice)}). There is no default: ` +
          `the backend is the sandbox's trust boundary, so the caller has to name it.`
      );
    }
    this.ctx = this.executor; // back-compat alias
    this.executorChoice = typeof executorChoice === 'string' ? executorChoice : 'custom';

    this.budget = {
      maxExecutions: opts.budget?.maxExecutions ?? 25,
      maxSubLlmCalls: opts.budget?.maxSubLlmCalls ?? 200,
      maxCostUsd: opts.budget?.maxCostUsd ?? 10,
    };
    this.shapingOptions = {
      label: opts.label,
      perCallTimeoutMs: opts.perCallTimeoutMs,
      budget: opts.budget,
      executorOptions: opts.executorOptions,
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
   * Record a sub-LLM call that has ALREADY hit the provider.
   *
   * Prefer `reserveSubLlm()`: this books the spend on the way back, so it
   * cannot refuse a call that is already in flight and cannot bound a
   * concurrent fan-out. Kept for callers whose spend is genuinely only
   * knowable after the fact.
   */
  recordSubLlm(opts: { costUsd: number; promptTokens?: number; completionTokens?: number }): void {
    this.usage.subLlmCalls += 1;
    this.bookSubLlmActuals(opts);

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
    this.enforceCostCap();
  }

  /**
   * Claim budget for one sub-LLM call BEFORE dispatching it, throwing
   * BudgetExceededError if the claim would breach a cap.
   *
   * `recordSubLlm` alone cannot bound a fan-out: it is called on the way
   * back, so `Promise.all` over N calls passes every check while all N are
   * in flight and the caps only fire once the provider has already been
   * billed N times. Reserving on the way out makes the counter move before
   * the request does, so the (N+1)th caller is refused while the first N are
   * still running.
   *
   * The estimate only has to be non-negative - `settle` replaces it with the
   * real number. Estimating high costs a caller nothing but a slightly
   * earlier cap; estimating at 0 opts out of cost-based admission control
   * and leaves only the call-count cap.
   *
   * A NaN or Infinity estimate is refused rather than coerced. Coercing it to
   * 0 (which is what this used to do) turned an unpriced call - exactly the
   * case the cap exists for - into the one shape that skips cost admission
   * control entirely, and did it silently.
   */
  reserveSubLlm(opts: { estimatedCostUsd: number }): SubLlmReservation {
    if (!Number.isFinite(opts.estimatedCostUsd)) {
      throw new BudgetExceededError(
        `sub-LLM cost estimate is not a finite number (${String(opts.estimatedCostUsd)}); refusing the ` +
          `call because an unpriced request cannot be capped (reservation refused)`
      );
    }
    const estimate = Math.max(0, opts.estimatedCostUsd);

    if (this.usage.subLlmCalls >= this.budget.maxSubLlmCalls) {
      const reason = `sub-LLM calls ${this.usage.subLlmCalls}/${this.budget.maxSubLlmCalls}`;
      this.safeEmit('budget:exceeded', {
        sessionId: this.sessionId,
        reason,
        phase: 'mid-execution',
        timestamp: Date.now(),
      });
      throw new BudgetExceededError(`${reason} (reservation refused)`);
    }
    const projected = this.usage.totalCostUsd + this.reservedCostUsd + estimate;
    if (projected >= this.budget.maxCostUsd) {
      const reason = `cost $${projected.toFixed(4)}/$${this.budget.maxCostUsd} (incl. in-flight)`;
      this.safeEmit('budget:exceeded', {
        sessionId: this.sessionId,
        reason,
        phase: 'mid-execution',
        timestamp: Date.now(),
      });
      throw new BudgetExceededError(`${reason} (reservation refused)`);
    }

    this.usage.subLlmCalls += 1;
    this.reservedCostUsd += estimate;
    this._lastAccessedAt = Date.now();

    let closed = false;
    return {
      settle: actual => {
        if (closed) return;
        closed = true;
        this.reservedCostUsd = Math.max(0, this.reservedCostUsd - estimate);
        // The call was counted at reservation time, so book the actuals
        // directly rather than through recordSubLlm (which counts again).
        //
        // A non-finite real cost falls back to the estimate we already
        // admitted. Booking the NaN instead would make totalCostUsd NaN for
        // the rest of the session, and every later comparison against the cap
        // false - so getUsage() would report NaN and the ceiling would be
        // whatever the last finite call happened to leave behind.
        this.bookSubLlmActuals(Number.isFinite(actual.costUsd) ? actual : { ...actual, costUsd: estimate });
        this.enforceCostCap();
      },
      release: () => {
        if (closed) return;
        closed = true;
        this.reservedCostUsd = Math.max(0, this.reservedCostUsd - estimate);
        this.usage.subLlmCalls -= 1;
      },
    };
  }

  /**
   * Book a completed sub-LLM call's real cost and tokens against an
   * ALREADY-COUNTED call and emit the observability event. Never throws, so
   * callers can enforce their caps in their own order.
   */
  private bookSubLlmActuals(opts: { costUsd: number; promptTokens?: number; completionTokens?: number }): void {
    // Last line of defence for the legacy `recordSubLlm` path, which has no
    // reservation to fall back on. A non-finite cost is dropped to 0 and
    // logged: it under-counts by one call's spend, where letting it through
    // would make the running total NaN and disable the cost cap outright for
    // every call after it.
    if (!Number.isFinite(opts.costUsd)) {
      Logger.globalInstance.warn(
        `[ReplSession] session "${this.sessionId}" booked a non-finite sub-LLM cost ` +
          `(${String(opts.costUsd)}); recording $0 for it. The call-count cap still applies.`
      );
      opts = { ...opts, costUsd: 0 };
    }
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
  }

  /** Throw once real spend has met or passed the session's cost ceiling. */
  private enforceCostCap(): void {
    if (this.usage.totalCostUsd < this.budget.maxCostUsd) return;
    const reason = `cost $${this.usage.totalCostUsd.toFixed(4)}/$${this.budget.maxCostUsd}`;
    this.safeEmit('budget:exceeded', {
      sessionId: this.sessionId,
      reason,
      phase: 'mid-execution',
      timestamp: Date.now(),
    });
    throw new BudgetExceededError(`${reason} (mid-execution)`);
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
    // Committed + in-flight: a fan-out still awaiting its provider responses
    // has already spent that money, so a pre-flight check that ignored
    // reservations would wave through another runCode on a dead budget.
    const projectedCostUsd = this.usage.totalCostUsd + this.reservedCostUsd;
    if (projectedCostUsd >= this.budget.maxCostUsd) {
      return `cost $${projectedCostUsd.toFixed(4)}/$${this.budget.maxCostUsd}`;
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

/**
 * The session-shaping options a cache hit cannot honour, because the session
 * they would configure already exists. `executor` is NOT among them - a
 * mismatch there throws, since it is the trust boundary. These four are
 * tuning, so first-caller-wins and we log rather than refuse; silently
 * ignoring them is how a caller ends up believing it set a budget it did not.
 */
const REUSE_IGNORED_OPTION_KEYS = ['label', 'perCallTimeoutMs', 'budget', 'executorOptions'] as const;

/**
 * Structural equality for a shaping option's value. Recursive rather than
 * key-wise: the values it compares are small records, but they are not flat
 * any more - `executorOptions.toolMinBudgetMs` is itself a record - and a
 * shallow compare would report two identical option objects as divergent and
 * warn on every reuse, which is the opposite of what this exists for.
 * Still no deep-equal dependency: these are records of primitives, nested.
 */
function shapingValueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every(
    k =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      shapingValueEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

function warnOnDivergentReuse(existing: ReplSession, opts: ReplSessionOptions): void {
  const configured = existing.configuredShapingOptions;
  const diverged = REUSE_IGNORED_OPTION_KEYS.filter(key => {
    const requested = opts[key];
    if (requested === undefined) return false;
    // Compared against what the session was actually built with, so asking
    // twice for the SAME configuration is silent. Warning on mere presence
    // meant a caller that passes a constant options object - which is the
    // normal shape at both production call sites - got this warning on every
    // single reuse, and a warning that fires when nothing is wrong is one
    // nobody reads when something is.
    return !shapingValueEquals(requested, configured[key]);
  });
  if (diverged.length === 0) return;
  Logger.globalInstance.warn(
    `[ReplSession] reusing cached session "${existing.sessionId}"; ignoring ${diverged.join(', ')} ` +
      `from this call - the existing session's values stand. Use a distinct sessionId if you need ` +
      `different ones.`
  );
}

export function getOrCreateReplSession(opts: ReplSessionOptions): ReplSession {
  const existing = sessionRegistry.get(opts.sessionId);
  if (existing) {
    // Reuse must not silently downgrade the sandbox. `executor` is mandatory
    // precisely so the backend is never implicit, and returning a cached
    // session built on a different one would hand the caller exactly the
    // implicit choice this option exists to prevent - potentially a
    // shared-realm backend where it asked for an isolate. Session ids are
    // per-request UUIDs at both production call sites today, so this is a
    // latent-collision guard rather than a live path.
    const requested = typeof opts.executor === 'string' ? opts.executor : 'custom';
    if (existing.executorChoice !== requested) {
      throw new Error(
        `ReplSession registry: session "${opts.sessionId}" already exists on the ` +
          `"${existing.executorChoice}" executor but was requested with "${requested}". ` +
          `Dispose it first or use a distinct sessionId.`
      );
    }
    // `'custom'` is not an identity. Two callers passing two different backend
    // instances both bucket under it, so the name check above passes and the
    // second caller silently runs on the FIRST caller's executor - sharing its
    // globals, its tool bindings, and whatever state the first guest left
    // behind. Compare the instance itself.
    if (requested === 'custom' && existing.executor !== opts.executor) {
      throw new Error(
        `ReplSession registry: session "${opts.sessionId}" already exists on a different custom ` +
          `ReplExecutor instance than the one requested. Reusing it would run this caller's code in ` +
          `the other caller's backend. Dispose it first or use a distinct sessionId.`
      );
    }
    warnOnDivergentReuse(existing, opts);
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
