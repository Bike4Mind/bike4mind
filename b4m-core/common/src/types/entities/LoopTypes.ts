import { IBaseRepository } from './BaseTypes';
import type { IWorkItem } from './WorkItemTypes';

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
export const LOOP_TICKET_TOOL_NAMES = [
  'loop_ticket_list',
  'loop_ticket_create',
  'loop_ticket_update',
  'loop_ticket_unsure',
  'loop_ticket_split',
] as const;

/**
 * Directive tools (`apps/workers/src/queueHandlers/agentExecutor.loopDirectiveTools.ts`): every loop run can
 * answer the directives sent to it; only runs of a loop with `oversees` get the overseer tools. Both lists are
 * pre-approved on headless loop runs in `startAgentExecution`.
 */
export const LOOP_DIRECTIVE_TOOL_NAMES = ['loop_directive_respond'] as const;
export const LOOP_OVERSEER_TOOL_NAMES = [
  'loop_oversee_status',
  'loop_directive_issue',
  'loop_run_now',
  'loop_resume',
] as const;

export const LOOP_AUTO_RESUME_KINDS = ['budget', 'credits'] as const;

export type LoopAutoResume = (typeof LOOP_AUTO_RESUME_KINDS)[number];

/**
 * Why a live, otherwise due loop is not running: paced to its daily budget, the server-wide run cap, or its p2
 * runs per day used up with only p2/p3 tickets ready (`priority_budget`, until 00:00 UTC).
 */
export const LOOP_HOLD_KINDS = ['pacing', 'capacity', 'priority_budget'] as const;
export type LoopHoldKind = (typeof LOOP_HOLD_KINDS)[number];

/** Liveness problems the scheduler flags to the owner: a live loop idle with ready tickets, or a run far longer than usual. */
export const LOOP_ALARM_KINDS = ['idle_with_work', 'long_run'] as const;
export type LoopAlarmKind = (typeof LOOP_ALARM_KINDS)[number];

export interface ILoopHold {
  kind: LoopHoldKind;
  /** Pacing and priority_budget: when the deferred run is due. */
  until?: Date;
  at: Date;
}

export interface ILoopAlarm {
  kind: LoopAlarmKind;
  reason: string;
  since: Date;
  /** long_run only: the run that is going long. */
  executionId?: string;
}

/** Midnight UTC of `now`'s day; a loop's daily budget counts runs started since then. */
export const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** The UTC midnight after `now`: when a loop's daily budgets reset. */
export const nextUtcMidnight = (now: Date): Date => new Date(startOfUtcDay(now).getTime() + 24 * 60 * 60 * 1000);

/** Hours a p0/p1 ticket may wait (open, running or parked on deps) before it is flagged stale; `ILoop.serviceLevelHours` overrides. */
export const LOOP_SERVICE_LEVEL_HOURS = { p0: 4, p1: 24 } as const;
/** Upper bounds of a loop's `serviceLevelHours` and `p2RunsPerDay`: the API, the form and LoopModel share them. */
export const LOOP_SERVICE_LEVEL_HOURS_MAX = 720;
export const LOOP_P2_RUNS_PER_DAY_MAX = 1000;

/**
 * Hours a p0/p1 ticket has waited past its loop's service level, counted from when its priority was last set
 * (`prioritySetAt`, else `createdAt`); null when it is within it or not covered. A ticket its owner blocked
 * already has a blocked notice, and an epic waits on its children, so neither counts. Shared by the notice sweep
 * (apps/workers/src/cron/loopNotices.ts) and the tickets route's `stale`.
 */
export function serviceLevelBreach(
  ticket: Pick<IWorkItem, 'priority' | 'status' | 'blockedOn' | 'epic' | 'prioritySetAt' | 'createdAt'>,
  loop: Pick<ILoop, 'serviceLevelHours'>,
  now: Date
): { hours: number; threshold: number } | null {
  const { priority } = ticket;
  if (priority !== 'p0' && priority !== 'p1') return null;
  if (ticket.epic || ticket.status === 'closed' || (ticket.status === 'blocked' && !ticket.blockedOn)) return null;
  const threshold = loop.serviceLevelHours?.[priority] ?? LOOP_SERVICE_LEVEL_HOURS[priority];
  const hours = (now.getTime() - new Date(ticket.prioritySetAt ?? ticket.createdAt).getTime()) / (60 * 60 * 1000);
  return hours > threshold ? { hours, threshold } : null;
}

/**
 * The model a ticket run uses. `runsAfterClaim` is the ticket's runCount including this run: the run that reaches
 * `limit` (the last before the ticket is blocked) uses the escalation model when one is set, the stage's first.
 * Shared by the cloud dispatch (apps/workers/src/cron/loopScheduler.ts) and the desktop claim (loopRunner.ts).
 */
export function loopRunModel(
  loop: Pick<ILoop, 'model' | 'escalationModel'>,
  stage: Pick<ILoopStageConfig, 'model' | 'escalationModel'>,
  runsAfterClaim: number,
  limit: number
): { model: string; escalated: boolean } {
  const escalation = stage.escalationModel ?? loop.escalationModel;
  if (escalation && runsAfterClaim === limit) return { model: escalation, escalated: true };
  return { model: stage.model ?? loop.model, escalated: false };
}

export const DEFAULT_LOOP_STAGES: readonly string[] = ['todo', 'doing', 'done'];

export const LOOP_STAGE_RUNNERS = ['cloud', 'desktop'] as const;

export type LoopStageRunner = (typeof LOOP_STAGE_RUNNERS)[number];

/** Per-stage overrides for runs that work a ticket in `stage`. Unset fields fall back to the loop's own. */
export interface ILoopStageConfig {
  /** One of the loop's `stages`, never the last. */
  stage: string;
  /** Owner-written; added to the prompt of runs working a ticket in this stage. */
  instructions?: string;
  /** Replaces the loop's `model`. */
  model?: string;
  /** Replaces the loop's `escalationModel` (`loopRunModel`). */
  escalationModel?: string;
  /** Replaces the loop's `tools`; empty or absent inherits them. */
  tools?: string[];
  /**
   * Absent means `cloud`. The cloud scheduler never claims a ticket in a `desktop` stage; a desktop runner
   * does.
   */
  runner?: LoopStageRunner;
  /** Desktop stages only, from here down: the guards a desktop runner applies to the ticket's work. `owner/name`. */
  repoHint?: string;
  /** Absent means `review`; served as `effectiveMergePolicy`. */
  mergePolicy?: LoopMergePolicy;
  deployWorkflow?: string;
  smoke?: LoopSmokeCheck;
  holdLabels?: string[];
}

export const LOOP_MERGE_POLICIES = ['review', 'green-ci', 'never'] as const;
export type LoopMergePolicy = (typeof LOOP_MERGE_POLICIES)[number];
export type LoopSmokeCheck = { url: string } | { command: string };

/** The merge policy a desktop runner applies: `review` when unset, and when the org turned `green-ci` merges off. */
export const effectiveMergePolicy = (
  policy: LoopMergePolicy | undefined,
  orgGreenCiDisabled?: boolean
): LoopMergePolicy => (!policy || (policy === 'green-ci' && orgGreenCiDisabled) ? 'review' : policy);

/** Header a desktop runner sends on its completion calls so their credits count toward the run's loop budgets. */
export const LOOP_RUN_HEADER = 'X-B4M-Loop-Run';
/** A desktop run's lease (ms); heartbeat and progress renew it, and the scheduler reopens the ticket once it lapses. */
export const RUNNER_LEASE_MS = 2 * 60_000;
/** A runner's presence counts as online this long (ms) after its last post. */
export const RUNNER_PRESENCE_FRESH_MS = 2 * 60_000;
/** Desktop runs a user may have active at once: the desktop app's lane cap. */
export const MAX_DESKTOP_RUNS_PER_USER = 4;

/** Desktop runner API shapes (apps/client/pages/api/loops/runner); the desktop app mirrors them. */
export interface RunnerTicket {
  ticketId: string;
  title: string;
  loopId: string;
  loopName: string;
  stage: string;
  repoHint?: string;
}

export interface RunnerClaim {
  ticket: RunnerTicket;
  runId: string;
  leaseExpiresAt: string;
  /** The same prompt a cloud run of this ticket gets. */
  prompt: string;
  model?: string;
  tools?: string[];
  stage: {
    mergePolicy: LoopMergePolicy;
    guards?: { deployWorkflow?: string; smoke?: LoopSmokeCheck; holdLabels?: string[] };
  };
}

export type LoopProgressFrame =
  | { type: 'text'; text: string }
  | { type: 'tool-start'; callId: string; name: string; input: string }
  | { type: 'tool-end'; callId: string; name: string; status: string; error?: string; preview?: string }
  | { type: 'usage'; usage: unknown };

export type RunnerOutcome =
  | { outcome: 'advanced'; answer: string; durationMs: number }
  | { outcome: 'blocked'; reason: string; answer?: string; durationMs: number }
  | { outcome: 'failed'; reason: string; durationMs: number }
  | { outcome: 'released'; reason?: string; durationMs: number };

/** A user's desktop runner, as last reported. One row per user: with two machines the last post wins. */
export interface ILoopRunnerPresence {
  id: string;
  userId: string;
  seenAt: Date;
  lanesBusy: number;
  lanesFree: number;
  waitingReason?: string;
}

export interface ILoopRunnerPresenceRepository {
  upsertForUser(userId: string, fields: Omit<ILoopRunnerPresence, 'id' | 'userId'>): Promise<void>;
  findByUserId(userId: string): Promise<ILoopRunnerPresence | null>;
}

/** The config for a stage; {} when it has none. */
export const stageConfigOf = (loop: Pick<ILoop, 'stageConfig'>, stage?: string): Omit<ILoopStageConfig, 'stage'> =>
  (loop.stageConfig ?? []).find(entry => entry.stage === stage) ?? {};

/** Stages whose tickets wait for a desktop runner. */
export const desktopStagesOf = (loop: Pick<ILoop, 'stageConfig'>): string[] =>
  (loop.stageConfig ?? []).filter(entry => entry.runner === 'desktop').map(entry => entry.stage);

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
  /** Sparse list keyed by `stage` (one of `stages`, never the last); see `stageConfigOf`. */
  stageConfig?: ILoopStageConfig[] | null;
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
  /** Idle runs in a row (no ticket, memory unchanged, no ticket touched); each doubles the wait before the next. */
  idleStreak?: number;
  /** Last Run now, owner edit, directive or ticket change; a run in flight across it is not idle. */
  idleResetAt?: Date;
  /** Ids of the same owner's loops this loop oversees: its runs may read their state and send them directives. */
  oversees?: string[];
  /** Why a live loop is held back on purpose right now; written only by the scheduler. */
  hold?: ILoopHold;
  /** A liveness problem for the owner; written only by the scheduler. */
  alarm?: ILoopAlarm;
  /** Per-priority overrides of LOOP_SERVICE_LEVEL_HOURS. */
  serviceLevelHours?: { p0?: number; p1?: number };
  /** Ticket runs (cloud and desktop) of p2 tickets per UTC day; absent means no cap. Over it, p2 and p3 wait. */
  p2RunsPerDay?: number;
  /** The model triage runs use; absent means `model`. */
  triageModel?: string;
  /** The model of a ticket's last run before its run limit (`loopRunModel`); absent means no escalation. */
  escalationModel?: string;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * GET /api/loops/budget: what all of the caller's loops spent today (since `startOfUtcDay`) against the
 * all-loops cap. `effectiveCap` is the lower of the admin and user caps; each is absent when unset.
 */
export interface ILoopsBudget {
  creditsToday: number;
  userDailyCredits?: number;
  adminDailyCredits?: number;
  effectiveCap?: number;
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
   * the loop still has that status, and with `guard.stages` only while its stages are exactly those.
   * Returns null when nothing matched.
   */
  updateForUser(
    id: string,
    userId: string,
    patch: Record<string, unknown>,
    expectedStatus?: LoopStatus,
    guard?: { stages?: string[] }
  ): Promise<ILoop | null>;
  deleteForUser(id: string, userId: string): Promise<boolean>;
  /** Atomically leases one due `live` loop with no run in flight and not in `skipIds`, or returns null. */
  claimDue(now: Date, leaseMs: number, skipIds?: string[], skipUserIds?: string[]): Promise<ILoop | null>;
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
  /** Pulls a `live` loop's `nextRunAt` forward to `now` and ends its idle back-off; used when one of its tickets becomes ready. */
  makeDueNow(id: string, now: Date): Promise<void>;
  /** Moves a still-`live` loop to `error` once it has `maxFailures` failures in a row. */
  markErroredIfFailing(id: string, maxFailures: number): Promise<void>;
  /** Drops a deleted loop from every other loop's `oversees`. */
  removeFromOversees(userId: string, loopId: string): Promise<void>;
  /** Paused loops with `autoResume` set. */
  listAutoPaused(): Promise<ILoop[]>;
  /**
   * Sets a loop paused with this `autoResume` back to `live`, due at `now`, clearing `autoResume` and
   * `statusReason`. Conditional on both, so an owner's edit landing first wins. False when nothing matched.
   */
  resumeAutoPaused(id: string, kind: LoopAutoResume, now: Date): Promise<boolean>;
  /**
   * Folds a finished desktop run into its loop: the new memory and `lastRunAt`, and one more `runCount`.
   * Never touches `activeExecutionId`, which only cloud runs hold.
   */
  foldRunnerRun(id: string, userId: string, memory: ILoopMemory, lastRunAt: Date): Promise<void>;
  /**
   * Defers a claimed live loop to `nextRunAt` under a hold of `kind` (default pacing) and releases the claim. The one
   * write of the deferring holds; a loop carries one hold, and `markDispatched` clears it.
   */
  deferUntil(id: string, nextRunAt: Date, now: Date, kind?: Exclude<LoopHoldKind, 'capacity'>): Promise<void>;
  clearCapacityHolds(): Promise<void>;
  /** Marks every live loop `claimDue` would take now, except `skipIds`, as held by the run cap. */
  setCapacityHolds(now: Date, skipIds: string[]): Promise<void>;
  /** Live loops with no run in flight due at or before `before`, oldest first. */
  listPastDueLive(before: Date, limit: number): Promise<ILoop[]>;
  /** Loops carrying an alarm, of `kinds` when given. */
  listAlarmed(kinds?: LoopAlarmKind[]): Promise<ILoop[]>;
  /**
   * Sets the alarm while it still applies (a long run while it is the active run; an idle alarm while the loop is
   * live with no run), keeping `since` when the same alarm (kind, and run for long_run) is already set.
   */
  setAlarm(id: string, alarm: ILoopAlarm): Promise<void>;
  clearAlarm(id: string, kind: LoopAlarmKind): Promise<void>;
}

/**
 * A per-loop event, kept past the execution TTL. `unsure` is a run the confidence gate paused: the
 * scheduler parks its ticket as blocked and records it here, with the owner's answer as its `resolution`.
 * Directives live in their own collection (`ILoopDirective`); the events API merges both into one log.
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
  /**
   * `unsure` only: `gate` (absent on older rows) is a run paused at the confidence gate, resolved through its
   * gate card; `asked` is a run asking the owner with `loop_ticket_unsure`, resolved from the Log.
   */
  source?: 'gate' | 'asked';
  executionId: string;
  workItemId?: string;
  ticketTitle?: string;
  /** Set on gate `unsure` only. */
  iteration?: number;
  /** Set on gate `unsure` only. */
  confidence?: number;
  reason: string;
  /** The gate's `requestedAt`; with `executionId` it identifies the event. */
  requestedAt: Date;
  /** `note` is the owner's answer to an `asked` event. */
  resolution?: { outcome: LoopGateOutcome; by?: string; at: Date; note?: string };
  /** Set once the scheduler has folded a resumed run back into its ticket. */
  foldedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

type LoopUnsureBase = Omit<
  ILoopEvent,
  'id' | 'kind' | 'source' | 'iteration' | 'confidence' | 'resolution' | 'foldedAt' | 'createdAt' | 'updatedAt'
>;

export type LoopUnsureFields = LoopUnsureBase & { source?: 'gate'; iteration: number; confidence: number };

export type LoopAskedFields = LoopUnsureBase & { source: 'asked' };

export type LoopAutoResumedFields = Pick<ILoopEvent, 'loopId' | 'userId' | 'executionId' | 'reason' | 'requestedAt'>;

export interface ILoopEventRepository extends IBaseRepository<ILoopEvent> {
  /** Records an unsure event once per gate (`executionId` + `requestedAt`); a repeat is a no-op. */
  recordUnsure(fields: LoopUnsureFields | LoopAskedFields): Promise<void>;
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
  /**
   * Resolves an unresolved `asked` event and marks it folded in the same write, so the scheduler's resumed-run
   * fold never picks it up (the asking run already ended). Null when no such event matched.
   */
  resolveAsked(
    id: string,
    userId: string,
    loopId: string,
    resolution: NonNullable<ILoopEvent['resolution']>
  ): Promise<ILoopEvent | null>;
  /** Undoes a `resolveAsked` written at `at` (when its ticket write failed), so the owner can answer again. */
  reopenAsked(id: string, at: Date): Promise<void>;
  /** A ticket's resumed `asked` events that carry the owner's answer, newest first. */
  listAnsweredForTicket(userId: string, workItemId: string, limit: number): Promise<ILoopEvent[]>;
  /** Whether a resumed event for this run is still waiting for the scheduler's fold. */
  hasUnfolded(executionId: string): Promise<boolean>;
  deleteManyForLoop(userId: string, loopId: string): Promise<number>;
}

/**
 * A directive one loop's run (the overseer) sends to another loop of the same owner (the worker). The worker
 * answers it on its next scheduled run with `loop_directive_respond`; the owner may withdraw or overrule it.
 *
 * | Who    | From                         | To                            |
 * |--------|------------------------------|-------------------------------|
 * | worker | open                         | accepted, pushed_back, done   |
 * | worker | accepted                     | pushed_back, done             |
 * | owner  | open, accepted, pushed_back  | withdrawn                     |
 * | owner  | pushed_back (overrule)       | open                          |
 */
export const LOOP_DIRECTIVE_STATES = ['open', 'accepted', 'pushed_back', 'done', 'withdrawn'] as const;

export type LoopDirectiveState = (typeof LOOP_DIRECTIVE_STATES)[number];

export type LoopDirectiveWorkerOutcome = 'accepted' | 'pushed_back' | 'done';
export type LoopDirectiveOwnerAction = 'withdraw' | 'overrule';

/** Directive text caps (characters); shared by the schema, the loop tools, the override route and the UI. */
export const LOOP_DIRECTIVE_INSTRUCTION_MAX = 2000;
export const LOOP_DIRECTIVE_REASON_MAX = 1000;
export const LOOP_DIRECTIVE_NOTE_MAX = 1000;

/** States each move is allowed from; shared by the worker tool and the owner override route. */
export const LOOP_DIRECTIVE_TRANSITIONS: Record<
  LoopDirectiveWorkerOutcome | LoopDirectiveOwnerAction,
  readonly LoopDirectiveState[]
> = {
  accepted: ['open'],
  pushed_back: ['open', 'accepted'],
  done: ['open', 'accepted'],
  withdraw: ['open', 'accepted', 'pushed_back'],
  overrule: ['pushed_back'],
};

/** An action an overseer took on a worker itself (`loop_run_now`, `loop_resume`), logged as a `done` directive. */
export const LOOP_DIRECTIVE_ACTIONS = ['run_now', 'resume'] as const;
export type LoopDirectiveAction = (typeof LOOP_DIRECTIVE_ACTIONS)[number];

export type ILoopDirectiveReply =
  | { by: 'worker'; outcome: LoopDirectiveWorkerOutcome; note?: string; executionId: string; at: Date }
  | { by: 'owner'; outcome: 'withdrawn' | 'overruled'; note?: string; userId: string; at: Date };

export interface ILoopDirective {
  id: string;
  /** The worker (target) loop. */
  loopId: string;
  userId: string;
  /** The overseer loop; its name is copied so the thread still reads after the overseer is deleted. */
  fromLoopId: string;
  fromLoopName: string;
  /** The overseer run that issued it. */
  executionId: string;
  instruction: string;
  reason: string;
  state: LoopDirectiveState;
  replies: ILoopDirectiveReply[];
  /** Set on an overseer action; such a row is always `done`, so it never reaches the worker or the owner's buttons. */
  action?: LoopDirectiveAction;
  createdAt: Date;
  updatedAt: Date;
}

export interface ILoopDirectiveRepository extends IBaseRepository<ILoopDirective> {
  countByExecution(executionId: string): Promise<number>;
  /** Overseer actions of this kind on a loop since `since`. */
  countActionsSince(loopId: string, action: LoopDirectiveAction, since: Date): Promise<number>;
  /** Open and accepted directives to a loop, oldest first: what its next run is shown. */
  listOpenForLoop(userId: string, loopId: string, limit: number): Promise<ILoopDirective[]>;
  /** Directives to a loop in any state, newest first. */
  listToLoop(userId: string, loopId: string, limit: number): Promise<ILoopDirective[]>;
  /** Directives to or from a loop, newest first: its Log. */
  listForLoop(userId: string, loopId: string, limit: number): Promise<ILoopDirective[]>;
  findByIdForUser(id: string, userId: string): Promise<ILoopDirective | null>;
  /** Moves the directive to `to` and appends `reply`, only while it is still in one of `from`. Null when it was not. */
  transition(
    id: string,
    userId: string,
    from: readonly LoopDirectiveState[],
    to: LoopDirectiveState,
    reply: ILoopDirectiveReply
  ): Promise<ILoopDirective | null>;
  deleteManyForLoop(userId: string, loopId: string): Promise<number>;
}
