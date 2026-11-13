import type {
  LoopMergePolicy,
  LoopRunOutcome,
  LoopSmokeCheck,
  WorkItemBlocker,
  WorkItemPriority,
  WorkItemPrioritySetter,
  WorkItemStageBy,
  WorkItemStatus,
} from '@bike4mind/common';
import { z } from 'zod';
import type { LoopApprovalMode } from './loopRunner';

/**
 * Loops owned by this Desktop: stored in main (main/loops/local), scheduled and run here, no web app involved.
 * Not the `/loop` slash command (shared/loop.ts) nor the runner for web loops' desktop stages (shared/loopRunner.ts).
 * Shapes follow the server's ILoop / IWorkItem, minus the fields Desktop loops do not use; dates are ISO strings.
 */

/** One stage's overrides. Every stage runs on this Mac, so there is no `runner`. */
export interface LocalLoopStageConfig {
  stage: string;
  instructions?: string;
  model?: string;
  escalationModel?: string;
  mergePolicy?: LoopMergePolicy;
  deployWorkflow?: string;
  smoke?: LoopSmokeCheck;
  holdLabels?: string[];
}

/** Why a live loop is not starting runs on its own. */
export type LocalLoopCapReason = 'loop_budget' | 'all_loops' | 'credits';

export interface LocalLoop {
  id: string;
  name: string;
  goal: string;
  stages: string[];
  stageConfig: LocalLoopStageConfig[];
  model: string;
  escalationModel?: string;
  /** Taken for new runs while the budget is running ahead of the day; see pacing.ts chooseRunModel. */
  fallbackModel?: string;
  /** Lanes this loop may run at once; the machine's lane pool bounds all loops together. */
  maxConcurrent: number;
  budgetCreditsPerDay?: number;
  p2RunsPerDay?: number;
  status: 'live' | 'paused' | 'error';
  /** Set with status `error`. */
  error?: string;
  /** The local checkout tickets run in; each run gets its own worktree of it. */
  directory: string;
  /** `owner/name` of the checkout's origin; loop_merge_pr merges only there. */
  repo?: string;
  approvalMode: LoopApprovalMode;
  /** Post a scrubbed status snapshot to the server for web and phone; on by default. */
  mirror: boolean;
  /** No run starts before this; cleared at the reset. */
  cappedUntil?: string;
  capReason?: LocalLoopCapReason;
  memory: { notes: string; nextAction: string };
  /** Runs in a row that ended in an error; three put the loop in `error`. */
  errorStreak: number;
  createdAt: string;
  updatedAt: string;
}

export interface LocalTicket {
  id: string;
  loopId: string;
  title: string;
  description?: string;
  stage: string;
  status: WorkItemStatus;
  /** Absent: untriaged, waiting for a triage run. */
  priority?: WorkItemPriority;
  prioritySetAt?: string;
  prioritySetBy?: WorkItemPrioritySetter;
  dependencies: string[];
  epic?: boolean;
  blockedOn?: WorkItemBlocker;
  statusReason?: string;
  /** Runs counted against `ticketRunLimit` since the owner last moved it. */
  runCount: number;
  lastRunModel?: string;
  lastRunFallback?: boolean;
  lastRunAdvanced?: boolean;
  /** Last WORK_ITEM_STAGE_HISTORY_MAX entries, oldest first. */
  stageHistory: { stage: string; at: string; by: WorkItemStageBy }[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

/** Desktop-only ways a run ended, beside its outcome: a stop the run did not choose. */
export type LocalRunStopReason = 'credit_cap' | 'requeued' | 'watchdog';

export interface LocalRun {
  id: string;
  loopId: string;
  /** Absent on a triage run. */
  ticketId?: string;
  kind: 'ticket' | 'triage';
  sessionId?: string;
  model: string;
  fallback: boolean;
  priority?: WorkItemPriority;
  startedAt: string;
  endedAt?: string;
  outcome?: LoopRunOutcome;
  stopReason?: LocalRunStopReason;
  reason?: string;
  /** Credits the run's sessions (and their spawned children) used so far. */
  credits: number;
  /** A PR the run opened or merged; a run cut off after this is handed to the owner, never re-run. */
  prUrl?: string;
}

export type LocalLoopEventKind = 'asked' | 'capped' | 'blocked' | 'error' | 'requeued';

export interface LocalLoopEvent {
  id: string;
  loopId: string;
  ticketId?: string;
  runId?: string;
  kind: LocalLoopEventKind;
  reason: string;
  /** `asked` only: the owner's answer, or a rejection. */
  resolution?: { outcome: 'answered' | 'rejected'; note?: string; at: string };
  createdAt: string;
}

export interface LocalLoopSummary {
  loop: LocalLoop;
  lanesBusy: number;
  spentToday: number;
  needsYou: number;
  /** Why it is idle, when it is. */
  idleReason?: string;
}

export interface LocalLoopDetail extends LocalLoopSummary {
  tickets: LocalTicket[];
  runs: LocalRun[];
  events: LocalLoopEvent[];
}

export type LocalLoopsResult<T> = { ok: true; value: T } | { ok: false; error: string };

const stageConfigSchema = z.object({
  stage: z.string().min(1),
  instructions: z.string().max(10_000).optional(),
  model: z.string().min(1).optional(),
  escalationModel: z.string().min(1).optional(),
  mergePolicy: z.enum(['review', 'green-ci', 'never']).optional(),
  deployWorkflow: z.string().min(1).optional(),
  smoke: z.union([z.object({ url: z.string().url() }), z.object({ command: z.string().min(1) })]).optional(),
  holdLabels: z.array(z.string()).optional(),
});

const loopFields = {
  name: z.string(),
  goal: z.string(),
  stages: z.array(z.string()),
  stageConfig: z.array(stageConfigSchema).optional(),
  model: z.string(),
  escalationModel: z.string().min(1).optional(),
  fallbackModel: z.string().min(1).optional(),
  maxConcurrent: z.number().optional(),
  budgetCreditsPerDay: z.number().optional(),
  p2RunsPerDay: z.number().int().min(0).optional(),
  directory: z.string().min(1),
  approvalMode: z.enum(['auto', 'full']).optional(),
  mirror: z.boolean().optional(),
};

export const createLocalLoopSchema = z.object(loopFields);
export type CreateLocalLoopRequest = z.infer<typeof createLocalLoopSchema>;

export const updateLocalLoopSchema = z.object({ id: z.string() }).extend(z.object(loopFields).partial().shape);
export type UpdateLocalLoopRequest = z.infer<typeof updateLocalLoopSchema>;

const priority = z.enum(['p0', 'p1', 'p2', 'p3']);

export const createLocalTicketSchema = z.object({
  loopId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  stage: z.string().optional(),
  priority: priority.optional(),
  dependencies: z.array(z.string()).optional(),
});
export type CreateLocalTicketRequest = z.infer<typeof createLocalTicketSchema>;

export const updateLocalTicketSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  stage: z.string().optional(),
  status: z.enum(['open', 'blocked', 'closed']).optional(),
  reason: z.string().optional(),
  priority: priority.nullable().optional(),
  dependencies: z.array(z.string()).optional(),
  delete: z.literal(true).optional(),
});
export type UpdateLocalTicketRequest = z.infer<typeof updateLocalTicketSchema>;

export const setLocalLoopStatusSchema = z.object({ id: z.string(), status: z.enum(['live', 'paused']) });

export const answerLocalEventSchema = z.object({
  id: z.string(),
  outcome: z.enum(['answered', 'rejected']),
  note: z.string().max(2000).optional(),
});
export type AnswerLocalEventRequest = z.infer<typeof answerLocalEventSchema>;

export const setLocalBudgetSchema = z.object({ dailyCredits: z.number().min(0).nullable() });
