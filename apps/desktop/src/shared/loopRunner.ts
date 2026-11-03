/**
 * The Desktop loop runner: works the tickets of loop stages marked to run on the user's machine.
 * Main drives it (main/loops), the renderer shows it in Settings > Loop runner.
 */

/**
 * How a stage's PR may be merged by loop_merge_pr. The server serves the EFFECTIVE policy, so an
 * org that turned green-ci off already arrives here as 'review'.
 */
export type LoopMergePolicy = 'review' | 'green-ci' | 'never';

/** A post-merge check: a URL that must answer 2xx, or a command that must exit 0 in the worktree. */
export type LoopSmokeCheck = { url: string } | { command: string };

/** The guards a stage applies after the turn. All optional; see main/loops/guards.ts. */
export interface LoopStageGuards {
  /** A GitHub Actions workflow (name or file) whose run on the merge commit must succeed. */
  deployWorkflow?: string;
  smoke?: LoopSmokeCheck;
  /** Labels that stop a merge. Defaults to DEFAULT_HOLD_LABELS. */
  holdLabels?: string[];
}

export const DEFAULT_HOLD_LABELS: readonly string[] = ['hold', 'human-merge', 'needs-approval'];

/** What runs unattended without a card. 'ask' is not offered: nobody is there to answer. */
export type LoopApprovalMode = 'auto' | 'full';

/** The user's one-time consent to run a loop's tickets on this machine. Stored per environment. */
export interface LoopPolicy {
  loopId: string;
  loopName: string;
  approvalMode: LoopApprovalMode;
  /** The local checkout the loop's tickets run in; each ticket gets its own worktree of it. */
  directory: string;
  /** `owner/name` the server named for the loop, checked against the folder's origin remote. */
  repoHint?: string;
  /** Used when the server serves none for the stage. */
  guards?: LoopStageGuards;
  approvedAt: string;
}

export interface LoopRunnerSettings {
  enabled: boolean;
  runOnBattery: boolean;
  /** Lower than the machine's own cap only; see main/loops/budget.ts laneCapFor. */
  laneCap?: number;
}

export interface LoopRunnerTicket {
  ticketId: string;
  title: string;
  loopId: string;
  loopName: string;
  stage: string;
  runId: string;
  sessionId: string;
  startedAt: string;
}

export interface LoopRunnerState {
  signedIn: boolean;
  server: string | null;
  settings: LoopRunnerSettings;
  openAtLogin: boolean;
  lanes: { cap: number; busy: number };
  tickets: LoopRunnerTicket[];
  /** Why no new ticket is being claimed now, e.g. "on battery". Absent when nothing holds it. */
  waitingReason?: string;
  /** Loops with work for this machine that the user has not approved yet. */
  pendingApprovals: { loopId: string; loopName: string; repoHint?: string }[];
  policies: LoopPolicy[];
  /** The last thing that went wrong talking to the server, shown until the next good poll. */
  error?: string;
}

export interface LoopApproveRequest {
  loopId: string;
  loopName: string;
  approvalMode: LoopApprovalMode;
  repoHint?: string;
}

export type LoopApproveResult = { ok: true; state: LoopRunnerState } | { ok: false; error: string };
