// The server runtime's limits and the runtime Lambda's sizing. Imports nothing, because infra/callableFunctionRuntime.ts
// reads the Lambda settings from here; runtimeParent.ts re-exports all of it.

export interface CallableFunctionLimits {
  /** The guest's own run (the contract read and `run`), timed from the child's run-start line. */
  timeoutMs: number;
  inputBytes: number;
  outputBytes: number;
  /** Resident memory of the child, in MB. */
  memoryMb: number;
  sourceBytes: number;
  printedChars: number;
}

const MIB = 1024 * 1024;

/**
 * The runtime's ceilings. A call may ask for a lower `timeoutMs`, `inputBytes`, or `outputBytes` in its
 * `limits`, never a higher one; each surface's default (chat's 256 KB output, for one) is the dispatcher's.
 */
export const CALLABLE_FUNCTION_LIMITS: CallableFunctionLimits = {
  timeoutMs: 825_000,
  inputBytes: 5 * MIB,
  outputBytes: 5 * MIB,
  memoryMb: 1536,
  sourceBytes: 512 * 1024,
  printedChars: 100_000,
};

/** A call's time limit when it names none. */
export const CALLABLE_FUNCTION_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Spawn to run start: Pyodide's load and the package wheels, outside the call's time limit. Loading all five
 * baked packages took up to 26 s on a heavily loaded host; this is a little over twice that.
 */
export const CALLABLE_FUNCTION_START_BUDGET_MS = 60_000;

/** The parent's own time around a run: the input checks and the wait for the killed child's reap. */
export const CALLABLE_FUNCTION_PARENT_MARGIN_MS = 15_000;

/** The queued-call consumer Lambda's own timeout, in seconds (infra/queues.ts). */
export const CALLABLE_FUNCTION_CALL_CONSUMER_TIMEOUT_SECONDS = 900;

/** Room the consumer keeps for its database reads and writes around the run. */
const CONSUMER_MARGIN_MS = 30_000;

/**
 * A queued call's longest time limit: what fits in the consumer with the runtime's start budget and margin.
 * `CallableFunctionTimeLimitSeconds` in b4m-core/common/src/schemas/settings.ts must allow exactly this many seconds.
 */
export const CALLABLE_FUNCTION_QUEUED_MAX_TIMEOUT_MS =
  CALLABLE_FUNCTION_CALL_CONSUMER_TIMEOUT_SECONDS * 1000 -
  CALLABLE_FUNCTION_START_BUDGET_MS -
  CALLABLE_FUNCTION_PARENT_MARGIN_MS -
  CONSUMER_MARGIN_MS;

/**
 * A run's time limit once its data files took `downloadMs` to download. The download counts against the call's own
 * limit, the budget the dispatcher's wait is sized from, so a cold download never outlasts the caller's wait.
 */
export function runTimeoutAfterDownload(timeoutMs: number, downloadMs: number): number {
  return Math.max(0, timeoutMs - downloadMs);
}

/** The runtime Lambda's configured timeout, in seconds; Lambda allows at most 900. */
export const CALLABLE_FUNCTION_LAMBDA_TIMEOUT_SECONDS = Math.ceil(
  (CALLABLE_FUNCTION_LIMITS.timeoutMs + CALLABLE_FUNCTION_START_BUDGET_MS + CALLABLE_FUNCTION_PARENT_MARGIN_MS) / 1000
);

/**
 * The runtime Lambda's memory, in MB: the child's limit plus room for the parent and for what the child can
 * allocate between two of the parent's memory polls. The Lambda's memory is the hard cap on both.
 */
export const CALLABLE_FUNCTION_LAMBDA_MEMORY_MB = CALLABLE_FUNCTION_LIMITS.memoryMb + 512;

/** The runtime Lambda's /tmp, in MB: Lambda's maximum. */
export const CALLABLE_FUNCTION_LAMBDA_EPHEMERAL_STORAGE_MB = 10_240;

/** Bounds the runtime's share of the account's concurrency pool, and so its worst-case spend. */
export const CALLABLE_FUNCTION_LAMBDA_RESERVED_CONCURRENCY = 50;

/**
 * Most queued calls the consumer runs at once (its event source's `maximumConcurrency`). Each holds one runtime
 * invocation for its whole run, so half the runtime's reserved concurrency leaves the other half to synchronous calls.
 */
export const CALLABLE_FUNCTION_CALL_CONSUMER_MAX_CONCURRENCY = CALLABLE_FUNCTION_LAMBDA_RESERVED_CONCURRENCY / 2;

/** callableFunctionCallQueue's visibility timeout and its receives before the dead-letter queue (infra/queues.ts). */
export const CALLABLE_FUNCTION_CALL_QUEUE_VISIBILITY_TIMEOUT_SECONDS = 1200;
export const CALLABLE_FUNCTION_CALL_QUEUE_MAX_RECEIVES = 2;
