import { IBaseRepository } from './BaseTypes';

/**
 * A Loop is a recurring, unattended agent run owned by a user. Every
 * `intervalMinutes` the loop scheduler (`apps/workers/src/cron/loopScheduler.ts`)
 * dispatches its `goal` as an ordinary headless agent execution under the loop's
 * notebook, then folds the run's `loop-memory` block back into `memory` so the
 * next run picks up where this one stopped.
 */
export const LOOP_STATUSES = ['draft', 'live', 'paused', 'needs_you', 'error'] as const;

export type LoopStatus = (typeof LOOP_STATUSES)[number];

/**
 * Server agent tools offered only on loop runs (`apps/workers/src/queueHandlers/agentExecutor.loopTicketTools.ts`).
 * Pre-approved on headless loop runs in `startAgentExecution`.
 */
export const LOOP_TICKET_TOOL_NAMES = ['loop_ticket_list', 'loop_ticket_create', 'loop_ticket_update'] as const;

export const DEFAULT_LOOP_STAGES: readonly string[] = ['todo', 'doing', 'done'];

/** State carried from one run to the next. */
export interface ILoopMemory {
  notes: string;
  nextAction: string;
  updatedAt?: Date;
}

export interface ILoop {
  id: string;
  userId: string;
  /** Billing target, checked against the owner's membership at write time. */
  organizationId?: string;
  name: string;
  /** The prompt each run is given. */
  goal: string;
  /**
   * Persisted agent whose orchestration profile the run uses. If that profile is
   * exclusive, the executor ignores `tools` and uses the profile's own toolset.
   */
  agentId?: string;
  model: string;
  /** Notebook every run is grouped under; created with the loop. */
  sessionId: string;
  intervalMinutes: number;
  /** Tool allowlist, passed as the run's `enabledTools`. Built-in names or `mcp__server__tool`. */
  tools: string[];
  stages: string[];
  /** Stored only; not enforced yet. */
  budgetCreditsPerDay?: number;
  status: LoopStatus;
  statusReason?: string;
  memory: ILoopMemory;
  lastRunAt?: Date;
  nextRunAt?: Date;
  lastExecutionId?: string;
  /** Set from dispatch until the run is folded in; a loop with one is never re-dispatched. */
  activeExecutionId?: string;
  /** Claim lease held by a scheduler tick while it dispatches. */
  leaseUntil?: Date;
  runCount: number;
  /** Non-credit failures in a row; the loop moves to `error` at the scheduler's limit. */
  consecutiveFailures: number;

  createdAt: Date;
  updatedAt: Date;
}

/** A loop as the loops API returns it: `creditsUsed` sums its top-level runs still within the execution TTL. */
export type ILoopWithUsage = ILoop & { creditsUsed: number };

export interface ILoopRepository extends IBaseRepository<ILoop> {
  listForUser(userId: string): Promise<ILoop[]>;
  findByIdAndUserId(id: string, userId: string): Promise<ILoop | null>;
  /**
   * Scoped update - a `null` in `patch` unsets the field. With `expectedStatus` it only applies while
   * the loop still has that status. Returns null when nothing matched.
   */
  updateForUser(
    id: string,
    userId: string,
    patch: Record<string, unknown>,
    expectedStatus?: LoopStatus
  ): Promise<ILoop | null>;
  deleteForUser(id: string, userId: string): Promise<boolean>;
  /** Atomically leases one due `live` loop with no run in flight and not in `skipIds`, or returns null. */
  claimDue(now: Date, leaseMs: number, skipIds?: string[]): Promise<ILoop | null>;
  releaseLease(id: string): Promise<void>;
  markDispatched(id: string, executionId: string, nextRunAt: Date): Promise<void>;
  listInFlight(): Promise<ILoop[]>;
  /**
   * Folds a finished run into the loop and clears `activeExecutionId`. Conditional on
   * `activeExecutionId === executionId`, so a second fold of the same run is a no-op.
   * Returns false when nothing matched.
   */
  foldRun(
    id: string,
    executionId: string,
    update: { $set?: Record<string, unknown>; $inc?: Record<string, number>; $unset?: Record<string, ''> }
  ): Promise<boolean>;
  /** Pulls a `live` loop's `nextRunAt` forward to `now`; used when one of its tickets becomes ready. */
  makeDueNow(id: string, now: Date): Promise<void>;
  /** Moves a still-`live` loop to `error` once it has `maxFailures` failures in a row. */
  markErroredIfFailing(id: string, maxFailures: number): Promise<void>;
}
