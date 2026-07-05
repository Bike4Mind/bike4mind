import { Logger } from '@bike4mind/observability';
/**
 * Circuit Breaker state machine for protecting external API calls.
 *
 * States: CLOSED (normal) -> OPEN (fail-fast) -> HALF_OPEN (testing recovery) -> CLOSED
 *
 * Uses a rolling window for failure counting: "5 failures in the last 2 minutes"
 * rather than "5 failures ever", preventing stale failures from tripping the breaker.
 */

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  /** Integration identifier (e.g., 'github', 'slack') */
  name: string;
  /** Failures in rolling window before OPEN (default: 5) */
  failureThreshold?: number;
  /** Successes in HALF_OPEN before CLOSED (default: 2) */
  successThreshold?: number;
  /** ms in OPEN before trying HALF_OPEN (default: 60000) */
  resetTimeout?: number;
  /** Rolling window for failure counting in ms (default: 120000) */
  rollingWindowMs?: number;
  /** Max concurrent calls allowed in HALF_OPEN (default: 1) */
  halfOpenMaxConcurrent?: number;
  /** Failure rate (0.0-1.0) that trips the breaker. Undefined = disabled (count-based only). */
  failureRateThreshold?: number;
  /** Minimum calls in rolling window before rate check applies (default: 10) */
  minimumCalls?: number;
  /** Callback for state transitions (wrapped in try-catch internally) */
  onStateChange?: (event: StateChangeEvent) => void;
  /** Classify which errors count as failures. Default: all errors count. */
  isFailure?: (error: Error) => boolean;
}

export interface StateChangeEvent {
  name: string;
  from: CircuitBreakerState;
  to: CircuitBreakerState;
  reason: string;
  timestamp: Date;
  metrics: CircuitBreakerSnapshot;
}

export interface CircuitBreakerSnapshot {
  state: CircuitBreakerState;
  failureCount: number;
  /** Successes in the current HALF_OPEN recovery probe (resets on state transitions; 0 when not in HALF_OPEN) */
  halfOpenSuccessCount: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  nextRetryTime: number | null;
  halfOpenActiveCount: number;
  /** Total calls in the rolling window */
  totalCalls: number;
  /** Failure rate in rolling window, null when rate tracking disabled or below minimumCalls */
  failureRate: number | null;
}

/**
 * Error thrown when the circuit breaker rejects a call (OPEN or HALF_OPEN state).
 */
export class CircuitBreakerError extends Error {
  public readonly circuitBreakerName: string;
  public readonly state: 'OPEN' | 'HALF_OPEN';

  constructor(name: string, state: 'OPEN' | 'HALF_OPEN') {
    super(`Circuit breaker '${name}' is ${state} — call rejected`);
    this.name = 'CircuitBreakerError';
    this.circuitBreakerName = name;
    this.state = state;
  }
}

/** Resolved config where optional numeric fields stay optional (undefined = disabled). */
type ResolvedConfig = Omit<Required<CircuitBreakerConfig>, 'failureRateThreshold'> & {
  failureRateThreshold: number | undefined;
};

export class CircuitBreaker {
  private readonly config: ResolvedConfig;
  private state: CircuitBreakerState = 'CLOSED';
  private failureTimestamps: number[] = [];
  private callTimestamps: number[] = [];
  private halfOpenSuccessCount = 0;
  private halfOpenActiveCount = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private openedAt: number | null = null;

  constructor(config: CircuitBreakerConfig) {
    this.config = {
      name: config.name,
      failureThreshold: config.failureThreshold ?? 5,
      successThreshold: config.successThreshold ?? 2,
      resetTimeout: config.resetTimeout ?? 60_000,
      rollingWindowMs: config.rollingWindowMs ?? 120_000,
      halfOpenMaxConcurrent: config.halfOpenMaxConcurrent ?? 1,
      failureRateThreshold: config.failureRateThreshold,
      minimumCalls: config.minimumCalls ?? 10,
      onStateChange: config.onStateChange ?? (() => {}),
      isFailure: config.isFailure ?? (() => true),
    };
  }

  /**
   * Execute a function through the circuit breaker.
   * - CLOSED: call executes normally; failures are tracked
   * - OPEN: call is rejected immediately with CircuitBreakerError
   * - HALF_OPEN: limited concurrent calls allowed to test recovery
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeTransitionToHalfOpen();

    if (this.state === 'OPEN') {
      throw new CircuitBreakerError(this.config.name, this.state);
    }

    if (this.state === 'HALF_OPEN') {
      if (this.halfOpenActiveCount >= this.config.halfOpenMaxConcurrent) {
        throw new CircuitBreakerError(this.config.name, this.state);
      }
      this.halfOpenActiveCount++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      let shouldCountAsFailure = true;
      try {
        shouldCountAsFailure = this.config.isFailure(err);
      } catch (classifierError) {
        // isFailure classifier crashed; default to counting as failure (conservative)
        Logger.globalInstance.error(
          `[CircuitBreaker] isFailure classifier crashed for '${this.config.name}':`,
          classifierError
        );
      }
      if (shouldCountAsFailure) {
        this.onFailure();
      } else {
        this.onSuccess();
      }
      throw error;
    } finally {
      if (this.state === 'HALF_OPEN' || this.halfOpenActiveCount > 0) {
        this.halfOpenActiveCount = Math.max(0, this.halfOpenActiveCount - 1);
      }
    }
  }

  /** Get a snapshot of the current state for monitoring/dashboards. */
  getState(): CircuitBreakerSnapshot {
    this.maybeTransitionToHalfOpen();
    this.pruneOldTimestamps();

    const totalCalls = this.callTimestamps.length;
    let failureRate: number | null = null;
    if (this.config.failureRateThreshold !== undefined && totalCalls >= this.config.minimumCalls) {
      failureRate = totalCalls > 0 ? this.failureTimestamps.length / totalCalls : 0;
    }

    return {
      state: this.state,
      failureCount: this.failureTimestamps.length,
      halfOpenSuccessCount: this.halfOpenSuccessCount,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      nextRetryTime: this.state === 'OPEN' && this.openedAt !== null ? this.openedAt + this.config.resetTimeout : null,
      halfOpenActiveCount: this.halfOpenActiveCount,
      totalCalls,
      failureRate,
    };
  }

  /** Admin override: force the breaker back to CLOSED. */
  reset(): void {
    const from = this.state;
    this.state = 'CLOSED';
    this.failureTimestamps = [];
    this.callTimestamps = [];
    this.halfOpenSuccessCount = 0;
    this.halfOpenActiveCount = 0;
    this.openedAt = null;

    if (from !== 'CLOSED') {
      this.notifyStateChange(from, 'CLOSED', 'Admin reset');
    }
  }

  /** Admin override: force the breaker to OPEN. */
  trip(): void {
    const from = this.state;
    this.state = 'OPEN';
    this.openedAt = Date.now();
    this.halfOpenSuccessCount = 0;
    this.halfOpenActiveCount = 0;

    if (from !== 'OPEN') {
      this.notifyStateChange(from, 'OPEN', 'Admin trip');
    }
  }

  private onSuccess(): void {
    this.pruneOldTimestamps();
    const now = Date.now();
    this.lastSuccessTime = now;
    this.callTimestamps.push(now);

    if (this.state === 'HALF_OPEN') {
      this.halfOpenSuccessCount++;
      if (this.halfOpenSuccessCount >= this.config.successThreshold) {
        this.transitionTo('CLOSED', `Recovery confirmed (${this.halfOpenSuccessCount} successes)`);
        this.failureTimestamps = [];
        this.callTimestamps = [];
        this.halfOpenSuccessCount = 0;
        this.openedAt = null;
      }
    }
  }

  private onFailure(): void {
    const now = Date.now();
    this.lastFailureTime = now;
    this.callTimestamps.push(now);

    if (this.state === 'HALF_OPEN') {
      // Set openedAt BEFORE transitionTo to prevent re-entrant maybeTransitionToHalfOpen
      // from seeing the stale openedAt inside the onStateChange callback's getState() call.
      this.openedAt = now;
      this.halfOpenSuccessCount = 0;
      this.transitionTo('OPEN', 'Failure during recovery test');
      return;
    }

    // CLOSED state: track rolling window failures
    this.failureTimestamps.push(now);
    this.pruneOldTimestamps();

    // Count-based trip check (always active)
    if (this.failureTimestamps.length >= this.config.failureThreshold) {
      this.openedAt = now;
      this.halfOpenSuccessCount = 0;
      this.transitionTo('OPEN', `${this.failureTimestamps.length} failures in rolling window`);
      return;
    }

    // Rate-based trip check (opt-in via failureRateThreshold)
    if (this.config.failureRateThreshold !== undefined && this.callTimestamps.length >= this.config.minimumCalls) {
      const rate = this.failureTimestamps.length / this.callTimestamps.length;
      if (rate >= this.config.failureRateThreshold) {
        this.openedAt = now;
        this.halfOpenSuccessCount = 0;
        this.transitionTo(
          'OPEN',
          `Failure rate ${(rate * 100).toFixed(0)}% exceeds threshold ${(this.config.failureRateThreshold * 100).toFixed(0)}%`
        );
      }
    }
  }

  private maybeTransitionToHalfOpen(): void {
    if (this.state !== 'OPEN' || this.openedAt === null) return;

    if (Date.now() - this.openedAt >= this.config.resetTimeout) {
      this.transitionTo('HALF_OPEN', `Reset timeout elapsed (${this.config.resetTimeout}ms)`);
      this.halfOpenSuccessCount = 0;
      this.halfOpenActiveCount = 0;
    }
  }

  private transitionTo(to: CircuitBreakerState, reason: string): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.notifyStateChange(from, to, reason);
  }

  private notifyStateChange(from: CircuitBreakerState, to: CircuitBreakerState, reason: string): void {
    try {
      this.config.onStateChange({
        name: this.config.name,
        from,
        to,
        reason,
        timestamp: new Date(),
        metrics: this.getState(),
      });
    } catch (err) {
      // Callback failures never break the breaker, but must be visible for debugging
      Logger.globalInstance.error(
        `[CircuitBreaker] onStateChange callback failed for '${this.config.name}' (${from} -> ${to}):`,
        err
      );
    }
  }

  private pruneOldTimestamps(): void {
    const cutoff = Date.now() - this.config.rollingWindowMs;
    this.failureTimestamps = this.failureTimestamps.filter(ts => ts > cutoff);
    this.callTimestamps = this.callTimestamps.filter(ts => ts > cutoff);
  }
}
