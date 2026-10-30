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
 * True when the loop's own status needs its owner: stopped by the scheduler (`needs_you`, `error`) or
 * paused with a reason. An owner pause clears `statusReason`, so it never counts. Shared by the notice
 * sweep (`apps/workers/src/cron/loopNotices.ts`) and the loop list marker (`loopNeedsOwner`).
 */
export const loopStatusNeedsOwner = (loop: Pick<ILoop, 'status' | 'statusReason'>): boolean =>
  loop.status === 'needs_you' || loop.status === 'error' || (loop.status === 'paused' && !!loop.statusReason);

/**
 * Server agent tools offered only on loop runs (`apps/workers/src/queueHandlers/agentExecutor.loopTicketTools.ts`).
 * Pre-approved on headless loop runs in `startAgentExecution`.
 */
export const LOOP_TICKET_TOOL_NAMES = ['loop_ticket_list', 'loop_ticket_create', 'loop_ticket_update'] as const;

export type LoopAutoResume = 'budget' | 'credits';

/** Midnight UTC of `now`'s day; a loop's daily budget counts runs started since then. */
export const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

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
  /** Tool allowlist, passed as the run's `enabledTools`. Built-in names or `<lowercased server>__<tool>` for MCP tools. */
  tools: string[];
  stages: string[];
  /** Enforced at dispatch per UTC day (`startOfUtcDay`); one run can overshoot it. */
  budgetCreditsPerDay?: number;
  status: LoopStatus;
  statusReason?: string;
  /** Set only by the scheduler on a pause it lifts itself; an owner pause never has it. */
  autoResume?: LoopAutoResume;
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

/**
 * A loop as the loops API returns it: `creditsUsed` sums its top-level runs still within the execution TTL,
 * `creditsToday` those started since `startOfUtcDay`; `blockedTickets` counts its live blocked tickets.
 */
export type ILoopWithUsage = ILoop & { creditsUsed: number; creditsToday: number; blockedTickets: number };

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
  /** Paused loops with `autoResume` set. */
  listAutoPaused(): Promise<ILoop[]>;
  /**
   * Sets a loop paused with this `autoResume` back to `live`, due at `now`, clearing `autoResume` and
   * `statusReason`. Conditional on both, so an owner's edit landing first wins. False when nothing matched.
   */
  resumeAutoPaused(id: string, kind: LoopAutoResume, now: Date): Promise<boolean>;
}

/**
 * A per-loop event, kept past the execution TTL. `unsure` is a run the confidence gate paused: the
 * scheduler parks its ticket as blocked and records it here; `gate_response` records the owner's answer.
 * `auto_resumed` is the scheduler lifting its own budget or credit pause; its `executionId` is the
 * loop's last run and `requestedAt` the resume time.
 */
export const LOOP_EVENT_KINDS = ['unsure', 'auto_resumed'] as const;

export type LoopEventKind = (typeof LOOP_EVENT_KINDS)[number];

export type LoopGateOutcome = 'resumed' | 'rejected';

export interface ILoopEvent {
  id: string;
  loopId: string;
  userId: string;
  kind: LoopEventKind;
  executionId: string;
  workItemId?: string;
  ticketTitle?: string;
  /** Set on `unsure` only. */
  iteration?: number;
  /** Set on `unsure` only. */
  confidence?: number;
  reason: string;
  /** The gate's `requestedAt`; with `executionId` it identifies the event. */
  requestedAt: Date;
  resolution?: { outcome: LoopGateOutcome; by?: string; at: Date };
  /** Set once the scheduler has folded a resumed run back into its ticket. */
  foldedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type LoopUnsureFields = Omit<
  ILoopEvent,
  'id' | 'kind' | 'iteration' | 'confidence' | 'resolution' | 'foldedAt' | 'createdAt' | 'updatedAt'
> & { iteration: number; confidence: number };

export type LoopAutoResumedFields = Pick<ILoopEvent, 'loopId' | 'userId' | 'executionId' | 'reason' | 'requestedAt'>;

export interface ILoopEventRepository extends IBaseRepository<ILoopEvent> {
  /** Records an unsure event once per gate (`executionId` + `requestedAt`); a repeat is a no-op. */
  recordUnsure(fields: LoopUnsureFields): Promise<void>;
  recordAutoResumed(fields: LoopAutoResumedFields): Promise<void>;
  /** Records the event if missing, then its resolution. The first resolution wins. */
  resolveUnsure(
    fields: LoopUnsureFields,
    resolution: { outcome: LoopGateOutcome; by?: string; at: Date }
  ): Promise<void>;
  /** Newest first. */
  listForLoop(userId: string, loopId: string, limit: number): Promise<ILoopEvent[]>;
  /** Resumed events whose run the scheduler has not folded yet. */
  listResumedUnfolded(limit: number): Promise<ILoopEvent[]>;
  markFolded(id: string, now: Date): Promise<void>;
  deleteManyForLoop(userId: string, loopId: string): Promise<number>;
}
