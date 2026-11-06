import type {
  ChatAutomaticOrigin,
  ChatApprovalMode,
  ChatSession,
  ChatStreamEvent,
  CreateCodeSessionRequest,
  CreateCodeSessionResult,
} from '@shared/chat';
import { DEFAULT_HOLD_LABELS, type LoopPolicy, type LoopRunnerState } from '@shared/loopRunner';
import { parsePullRequestUrl, type PrMergeMethod, type PrRef, type PrSnapshot } from '@shared/pullRequest';
import type { AutomaticTurnResult } from '../chat/ChatService';
import type { GhRunner } from '../pr/gh';
import { admit, hardFloorBreached, laneCapFor, type MachineSample } from './budget';
import { mergeDecision, readLabels, runDeployCheck, runSmoke, type SmokeDeps } from './guards';
import {
  LeaseLost,
  USER_WIDE_REFUSALS,
  type LoopRunnerApi,
  type RunnerClaim,
  type RunnerOutcome,
} from './LoopRunnerClient';
import type { LoopPolicyStore } from './LoopPolicyStore';
import { ProgressBatcher } from './progress';

/** The parts of ChatService the runner drives; every call is one a user's own click could make. */
export interface RunnerChat {
  createCodeSession(request: CreateCodeSessionRequest): Promise<CreateCodeSessionResult>;
  setApprovalMode(sessionId: string, mode: ChatApprovalMode): Promise<unknown>;
  setLoopRunModel(sessionId: string, model: string): Promise<unknown>;
  startAutomaticTurn(sessionId: string, text: string, automatic: ChatAutomaticOrigin): Promise<AutomaticTurnResult>;
  stop(sessionId: string): void;
  isSessionBusy(sessionId: string): boolean;
  getSession(sessionId: string): Promise<ChatSession | null>;
  deleteSession(sessionId: string, removeWorktree?: boolean): Promise<void>;
  removeWorktrees(directory: string, paths?: readonly string[]): Promise<unknown>;
  loopRunOf(sessionId: string): string | undefined;
  loopRunSessions(runId: string): string[];
  endLoopRun(runId: string): void;
}

export interface RunnerGithub {
  snapshot(ref: PrRef, options: { threads: boolean; queue?: boolean }): Promise<PrSnapshot>;
  merge(ref: PrRef, method: PrMergeMethod, headSha: string): Promise<void>;
  enqueue(nodeId: string, headSha: string): Promise<number>;
  findOpenForBranch(cwd: string, branch: string): Promise<string | null>;
}

export interface LoopRunnerDeps {
  client: LoopRunnerApi;
  chat: RunnerChat;
  /** Kills a session's background process groups, and only that session's. */
  killSessionProcesses(sessionId: string): Promise<void> | void;
  store: LoopPolicyStore;
  /** The signed-in environment's key and server URL, or null when signed out. */
  environment(): { key: string; url: string } | null;
  sample(): Promise<MachineSample>;
  gh: GhRunner;
  github: RunnerGithub;
  powerSaveBlocker: { start(type: 'prevent-app-suspension'): number; stop(id: number): void };
  smoke?: SmokeDeps;
  /** Whether a window has focus; polling stays fast while the user is looking. */
  focused(): boolean;
  onChange(): void;
  logger: { warn(message: string): void };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const RUNNER_MS = {
  /**
   * While a lane is free and there is work or a window has focus. The one knob to retire once the
   * server pushes loop changes over a socket (Desktop has no socket client yet).
   */
  claimPoll: 10_000,
  /** Every lane busy: presence only; a lane freeing runs a claim pass at once. */
  busyPoll: 15_000,
  idlePollMax: 5 * 60_000,
  heartbeat: 45_000,
  /** Worktrees older than this are removed even with a PR still open. */
  worktreeMaxAge: 7 * 24 * 60 * 60_000,
  gcEvery: 24 * 60 * 60_000,
  stopWait: 10_000,
} as const;

/** An outcome as the runner decides it; `durationMs` is added when it is reported. */
type Outcome = WithoutDuration<RunnerOutcome>;
type WithoutDuration<T> = T extends unknown ? Omit<T, 'durationMs'> : never;

/** What the Settings panel says for a refusal that holds every claim this poll. */
const USER_WIDE_REASON: Record<string, string> = {
  lanes_full: 'your desktop runs are at their limit',
  user_budget: 'your loops have spent their daily budget',
};

/**
 * A completions refusal at the credit cap: the run stops and the ticket goes back, never retried.
 * Matches both of completions.ts toRequestError's forms, with and without the server's body.
 */
const CREDIT_STOP = /status 422\b/;

interface Lane {
  claim: RunnerClaim;
  policy: LoopPolicy;
  sessionId: string;
  startedAt: number;
  batcher: ProgressBatcher;
  heartbeat: ReturnType<typeof setInterval>;
  /** What the last approval card in this run asked for: the block reason if it goes unanswered. */
  pending?: string;
  merged?: { pr: PrRef; mergeSha?: string };
  /** Set once the run has an outcome; later events for it are ignored. */
  finished: boolean;
}

function pendingReason(event: ChatStreamEvent): string | undefined {
  if (event.type !== 'tool-start' || event.call.status !== 'awaiting-approval') return undefined;
  const { call } = event;
  if (call.name === 'ask_user') {
    const questions = Array.isArray(call.input.questions) ? (call.input.questions as { question?: unknown }[]) : [];
    const asked = questions
      .map(question => (typeof question.question === 'string' ? question.question : ''))
      .filter(Boolean);
    return `Question: ${asked.join(' / ') || 'the agent asked for input'}`;
  }
  return `Needs approval: ${call.approvalDetail ?? call.name}`;
}

/**
 * Claims tickets of desktop-run loop stages and works each one in its own worktree session,
 * unattended, within the machine budget. See shared/loopRunner.ts for what the user sees.
 *
 * Only ever stops, kills or deletes sessions it started (and their spawned children, which
 * ChatService marks with the same run id), and only removes worktrees it recorded.
 */
export class LoopRunner {
  private readonly lanes = new Map<string, Lane>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private gcTimer: ReturnType<typeof setInterval> | undefined;
  private idleDelay: number = RUNNER_MS.claimPoll;
  private previous: MachineSample | undefined;
  private blocker: number | null = null;
  private running = false;
  /** Set by releaseAll: the app is going, so finishing runs skip the worktree GC and its gh calls. */
  private quitting = false;
  private ticking = false;
  /** A claim pass was asked for while one was running; run another as soon as it ends. */
  private again = false;
  private waitingReason: string | undefined;
  /** loopId -> until when its tickets are not claimed, after a run stopped at its credit cap. */
  private readonly creditStops = new Map<string, number>();
  private error: string | undefined;
  private pendingApprovals: LoopRunnerState['pendingApprovals'] = [];
  private cap = 1;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: LoopRunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  /** Start polling. Safe to call again; a second call only polls sooner. */
  start(): void {
    // Turning the runner on is the user's retry after a credit stop; an auth refresh re-calling start is not.
    if (!this.running) this.creditStops.clear();
    this.running = true;
    this.quitting = false;
    this.gcTimer ??= setInterval(() => void this.collectWorktrees(), RUNNER_MS.gcEvery);
    void this.collectWorktrees();
    this.schedule(0);
  }

  /** Stop claiming. Work in flight carries on until it finishes or releaseAll is called. */
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.gcTimer = undefined;
    this.waitingReason = undefined;
    this.deps.onChange();
  }

  get busy(): number {
    return this.lanes.size;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = this.running ? setTimeout(() => void this.tick(), ms) : undefined;
  }

  /** One poll: presence, budget, then claim what the budget admits. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    this.again = false;
    let next: number = RUNNER_MS.claimPoll;
    try {
      next = await this.poll();
      this.error = undefined;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.idleDelay = Math.min(this.idleDelay * 2, RUNNER_MS.idlePollMax);
      next = this.idleDelay;
    } finally {
      this.ticking = false;
      this.deps.onChange();
      if (this.running) this.schedule(this.again ? 0 : next);
    }
  }

  private async poll(): Promise<number> {
    const env = this.deps.environment();
    if (!env) return RUNNER_MS.idlePollMax;
    const settings = await this.deps.store.settings(env.key);
    const sample = await this.deps.sample();
    const previous = this.previous;
    this.previous = sample;
    this.cap = laneCapFor(sample.cores, settings.laneCap);

    const breached = hardFloorBreached(sample);
    if (breached) {
      this.waitingReason = breached;
      await this.stopAll(breached);
    }

    const tickets = await this.deps.client.listTickets();
    const policies = new Map((await this.deps.store.policies(env.key)).map(policy => [policy.loopId, policy]));
    const running = new Set([...this.lanes.values()].map(lane => lane.claim.ticket.ticketId));
    const unapproved = new Map<string, LoopRunnerState['pendingApprovals'][number]>();
    for (const ticket of tickets) {
      if (!policies.has(ticket.loopId)) {
        unapproved.set(ticket.loopId, {
          loopId: ticket.loopId,
          loopName: ticket.loopName,
          ...(ticket.repoHint ? { repoHint: ticket.repoHint } : {}),
        });
      }
    }
    this.pendingApprovals = [...unapproved.values()];

    if (!breached) {
      this.waitingReason = undefined;
      for (const ticket of tickets) {
        const policy = policies.get(ticket.loopId);
        if (!policy || running.has(ticket.ticketId)) continue;
        const admission = admit(sample, previous, this.lanes.size, settings);
        if (!admission.ok) {
          this.waitingReason = admission.reason;
          break;
        }
        if ((this.creditStops.get(ticket.loopId) ?? 0) > this.now()) continue;
        const claim = await this.deps.client.claim(ticket.ticketId);
        if ('refused' in claim) {
          // Any other refusal is about this ticket only (taken, not open, its loop's budget).
          if (!USER_WIDE_REFUSALS.has(claim.refused)) continue;
          this.waitingReason = USER_WIDE_REASON[claim.refused] ?? claim.refused;
          break;
        }
        await this.run(claim, policy);
      }
    }

    await this.deps.client
      .presence({
        lanesBusy: this.lanes.size,
        lanesFree: Math.max(this.cap - this.lanes.size, 0),
        ...(this.waitingReason ? { waitingReason: this.waitingReason } : {}),
      })
      .catch(() => undefined);

    if (this.lanes.size >= this.cap) return RUNNER_MS.busyPoll;
    if (this.lanes.size > 0 || tickets.length > 0 || this.deps.focused()) {
      this.idleDelay = RUNNER_MS.claimPoll;
      return RUNNER_MS.claimPoll;
    }
    this.idleDelay = Math.min(this.idleDelay * 2, RUNNER_MS.idlePollMax);
    return this.idleDelay;
  }

  /**
   * Work one claimed ticket. Whatever happens, the claim ends in a complete or a release: the
   * server never moves a desktop-stage ticket for us, and a lapsed lease is only the backstop.
   */
  private async run(claim: RunnerClaim, policy: LoopPolicy): Promise<void> {
    const { runId } = claim;
    let sessionId: string | undefined;
    try {
      const created = await this.deps.chat.createCodeSession({ directory: policy.directory, workspace: true });
      if (!created.ok) {
        await this.report(runId, this.now(), { outcome: 'failed', reason: created.error });
        return;
      }
      sessionId = created.session.id;
      await this.deps.chat.setApprovalMode(sessionId, policy.approvalMode);
      if (claim.model) await this.deps.chat.setLoopRunModel(sessionId, claim.model);
    } catch (err) {
      // No turn has run, so no worktree exists yet: only the empty conversation is left to remove.
      if (sessionId) await this.deps.chat.deleteSession(sessionId).catch(() => undefined);
      await this.report(runId, this.now(), { outcome: 'released', reason: `could not start: ${String(err)}` });
      return;
    }
    const lane: Lane = {
      claim,
      policy,
      sessionId,
      startedAt: this.now(),
      finished: false,
      batcher: new ProgressBatcher(
        frames => this.deps.client.progress(runId, frames),
        err => {
          if (err instanceof LeaseLost) void this.abandon(lane, err.reason);
        }
      ),
      heartbeat: setInterval(() => {
        this.deps.client.heartbeat(runId).catch(err => {
          if (err instanceof LeaseLost) void this.abandon(lane, err.reason);
        });
      }, RUNNER_MS.heartbeat),
    };
    this.lanes.set(runId, lane);
    this.updateBlocker();

    const started = await this.deps.chat
      .startAutomaticTurn(sessionId, claim.prompt, {
        kind: 'loop-runner',
        loopId: claim.ticket.loopId,
        ticketId: claim.ticket.ticketId,
        runId,
        summary: claim.ticket.title,
      })
      .catch((err: unknown) => ({ ok: false as const, error: String(err) }));
    if (!started.ok) await this.finish(lane, { outcome: 'failed', reason: started.error });
  }

  private laneOf(sessionId: string): Lane | undefined {
    const runId = this.deps.chat.loopRunOf(sessionId);
    if (runId) return this.lanes.get(runId);
    // Deleting a session drops its marking before its turn stops, so the turn's last event arrives unmarked.
    return [...this.lanes.values()].find(lane => lane.sessionId === sessionId);
  }

  /** Every chat stream event, from the main-process observer. */
  observe(event: ChatStreamEvent): void {
    if (!('sessionId' in event)) return;
    const lane = this.laneOf(event.sessionId);
    if (!lane || lane.finished) return;
    const pending = pendingReason(event);
    if (pending) lane.pending = pending;
    if (event.sessionId !== lane.sessionId) return;
    lane.batcher.push(event);
    if (event.type === 'error' && CREDIT_STOP.test(event.message)) {
      this.creditStop(lane.claim.ticket.loopId);
      void this.finish(lane, { outcome: 'released', reason: 'out of credits' });
    } else if (event.type === 'error') void this.finish(lane, { outcome: 'failed', reason: event.message });
    if (event.type !== 'done') return;
    // The user pressed Stop (or deleted the conversation): the work is unfinished, and theirs now.
    if (event.stopReason === 'aborted')
      void this.finish(lane, { outcome: 'blocked', reason: 'Stopped on the desktop' });
    else void this.turnDone(lane, event.content);
  }

  /** ApprovalGate closed a card in a runner session: nobody can answer it, so the user gets the ticket. */
  unattended(sessionId: string): void {
    const lane = this.laneOf(sessionId);
    if (lane && !lane.finished)
      void this.finish(lane, { outcome: 'blocked', reason: lane.pending ?? 'Needs approval' });
  }

  private async turnDone(lane: Lane, answer: string): Promise<void> {
    // A spawned child still working reports back to this session, which then takes another turn.
    const children = this.deps.chat.loopRunSessions(lane.claim.runId).filter(id => id !== lane.sessionId);
    if (children.some(id => this.deps.chat.isSessionBusy(id))) return;
    if (lane.finished) return;
    lane.finished = true;
    // The heartbeat keeps running through the checks, so a long deploy wait holds the lease.
    const outcome = await this.postTurnChecks(lane, answer).catch((err: unknown): Outcome => ({
      outcome: 'blocked',
      reason: `post-merge check failed: ${String(err)}`,
      answer,
    }));
    await this.finish(lane, outcome, true);
  }

  /** After a merge: the stage's deploy workflow, then its smoke check. Either failing blocks the ticket. */
  private async postTurnChecks(lane: Lane, answer: string): Promise<Outcome> {
    const guards = lane.claim.stage.guards ?? lane.policy.guards;
    // No merge sha means the PR went to the merge queue, which may still drop it: wait for it to land.
    if (lane.merged && (guards?.deployWorkflow || !lane.merged.mergeSha)) {
      const deployed = await runDeployCheck(
        this.deps.gh,
        {
          pr: lane.merged.pr,
          mergeSha: lane.merged.mergeSha,
          ...(guards?.deployWorkflow ? { workflow: guards.deployWorkflow } : {}),
          cwd: lane.policy.directory,
        },
        { now: this.now, sleep: this.sleep }
      );
      if (!deployed.ok) return { outcome: 'blocked', reason: deployed.reason, answer };
    }
    if (lane.merged && guards?.smoke) {
      const session = await this.deps.chat.getSession(lane.sessionId);
      const cwd = session?.project?.workingDirectory ?? lane.policy.directory;
      const smoked = await runSmoke(guards.smoke, cwd, this.deps.smoke);
      if (!smoked.ok) return { outcome: 'blocked', reason: smoked.reason, answer };
    }
    return { outcome: 'advanced', answer };
  }

  private creditStopped(): boolean {
    return [...this.creditStops.values()].some(until => until > this.now());
  }

  /** Hold the loop's tickets until the next UTC day, when its budgets reset; a restart clears it. */
  private creditStop(loopId: string): void {
    const now = new Date(this.now());
    this.creditStops.set(loopId, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    this.deps.onChange();
  }

  /** loop_merge_pr: merge under the stage's policy, or block the ticket with why not. */
  async merge(sessionId: string, prUrl: string): Promise<string> {
    const lane = this.laneOf(sessionId);
    if (!lane || lane.finished) throw new Error('This session is not working on a loop ticket.');
    const ref = parsePullRequestUrl(prUrl);
    if (!ref) throw new Error(`Not a GitHub pull request URL: ${prUrl}`);
    const blocked = (reason: string): never => {
      void this.finish(lane, { outcome: 'blocked', reason });
      throw new Error(`${reason} The ticket is handed to the user; stop here.`);
    };

    // Only the loop's own repository: the user's gh could merge a green PR anywhere it has rights.
    const repo = lane.policy.repo ?? lane.policy.repoHint?.toLowerCase();
    if (`${ref.owner}/${ref.repo}`.toLowerCase() !== repo)
      return blocked(`${ref.url} is not in this loop's repository (${repo ?? 'unknown'}).`);

    const guards = lane.claim.stage.guards ?? lane.policy.guards;
    let snapshot: PrSnapshot;
    let labels: string[];
    try {
      [snapshot, labels] = await Promise.all([
        this.deps.github.snapshot(ref, { threads: false, queue: true }),
        readLabels(this.deps.gh, ref),
      ]);
    } catch (err) {
      // Not a tool error the model could finish past: an unreadable PR is not merged, so the ticket waits.
      return blocked(`Could not read ${ref.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const decision = mergeDecision(
      snapshot,
      labels,
      lane.claim.stage.mergePolicy,
      guards?.holdLabels ?? DEFAULT_HOLD_LABELS
    );
    if (!decision.merge) return blocked(decision.reason);
    try {
      if (decision.via === 'queue') {
        if (!snapshot.nodeId) return blocked('GitHub did not give the PR id needed to enqueue it.');
        await this.deps.github.enqueue(snapshot.nodeId, snapshot.headSha);
        lane.merged = { pr: ref };
        return `Added ${ref.url} to the merge queue.`;
      }
      await this.deps.github.merge(ref, decision.method, snapshot.headSha);
    } catch (err) {
      return blocked(`GitHub refused the merge: ${err instanceof Error ? err.message : String(err)}`);
    }
    const view = await this.deps
      .gh(['pr', 'view', ref.url, '--json', 'mergeCommit'])
      .then(text => (JSON.parse(text) as { mergeCommit?: { oid?: string } | null }).mergeCommit?.oid)
      .catch(() => undefined);
    lane.merged = { pr: ref, ...(view ? { mergeSha: view } : {}) };
    return `Merged ${ref.url}.`;
  }

  /**
   * Report the outcome once, stop whatever of the run is still going, then clean up. `force`
   * lets the post-turn checks, which already claimed the outcome, report it.
   */
  private async finish(lane: Lane, outcome: Outcome, force = false): Promise<void> {
    if (lane.finished && !force) return;
    lane.finished = true;
    clearInterval(lane.heartbeat);
    await this.stopSessions(lane.claim.runId);
    await lane.batcher.flush();
    lane.batcher.dispose();
    await this.report(lane.claim.runId, lane.startedAt, outcome);
    this.laneFreed(lane);
    await this.retire(lane).catch(err => this.deps.logger.warn(`LOOPS: cleanup failed: ${String(err)}`));
  }

  private async report(runId: string, startedAt: number, outcome: Outcome): Promise<void> {
    await this.deps.client
      .complete(runId, { ...outcome, durationMs: this.now() - startedAt })
      .catch(err => this.deps.logger.warn(`LOOPS: could not report run ${runId}: ${String(err)}`));
  }

  /**
   * The run ended on the server (the web run view's Stop, the credit cap, a lapsed lease): stop
   * without reporting, since a complete would only get another 410.
   */
  private async abandon(lane: Lane, reason: string): Promise<void> {
    if (lane.finished) return;
    if (reason === 'credit_cap') this.creditStop(lane.claim.ticket.loopId);
    lane.finished = true;
    clearInterval(lane.heartbeat);
    lane.batcher.dispose();
    await this.stopSessions(lane.claim.runId);
    this.laneFreed(lane);
    await this.retire(lane).catch(() => undefined);
  }

  /** Stop this run's sessions and kill their process groups. Never touches any other session. */
  private async stopSessions(runId: string): Promise<void> {
    const sessions = this.deps.chat.loopRunSessions(runId);
    for (const sessionId of sessions) this.deps.chat.stop(sessionId);
    await Promise.all(
      sessions.map(sessionId => Promise.resolve(this.deps.killSessionProcesses(sessionId)).catch(() => undefined))
    );
  }

  /** Hard floor: hand every ticket back and stop only the runner's own sessions. */
  private async stopAll(reason: string): Promise<void> {
    await Promise.all([...this.lanes.values()].map(lane => this.finish(lane, { outcome: 'released', reason })));
  }

  /** Quit: hand everything back now, so the server re-offers it without waiting out the lease. */
  async releaseAll(): Promise<void> {
    this.quitting = true;
    this.stop();
    await this.stopAll('the desktop app quit');
  }

  dispose(): void {
    this.stop();
    for (const lane of this.lanes.values()) {
      clearInterval(lane.heartbeat);
      lane.batcher.dispose();
    }
    this.lanes.clear();
    this.updateBlocker();
  }

  /** Drop the lane and take the next ticket now rather than at the next poll. */
  private laneFreed(lane: Lane): void {
    this.lanes.delete(lane.claim.runId);
    this.updateBlocker();
    this.deps.onChange();
    if (this.running) void this.tick();
  }

  private updateBlocker(): void {
    if (this.lanes.size > 0 && this.blocker === null) {
      this.blocker = this.deps.powerSaveBlocker.start('prevent-app-suspension');
    } else if (this.lanes.size === 0 && this.blocker !== null) {
      this.deps.powerSaveBlocker.stop(this.blocker);
      this.blocker = null;
    }
  }

  /**
   * Record each of the run's worktrees and end the run's marking in ChatService, then remove the
   * worktrees without an open PR. One whose PR is still open is kept for the user, and collected
   * later by collectWorktrees. Not on quit: the GC's gh calls would hold the quit up.
   */
  private async retire(lane: Lane): Promise<void> {
    try {
      for (const sessionId of this.deps.chat.loopRunSessions(lane.claim.runId)) {
        const project = (await this.deps.chat.getSession(sessionId))?.project;
        if (!project?.workspace || !project.workspaceBranch) continue;
        await this.deps.store.recordWorktree({
          sessionId,
          directory: project.directory,
          path: project.workingDirectory,
          branch: project.workspaceBranch,
          ticketId: lane.claim.ticket.ticketId,
          createdAt: new Date(lane.startedAt).toISOString(),
          finishedAt: new Date(this.now()).toISOString(),
        });
      }
    } finally {
      this.deps.chat.endLoopRun(lane.claim.runId);
    }
    if (!this.quitting) await this.collectWorktrees();
  }

  /** Remove recorded runner worktrees that are finished with no open PR, or past the age limit. */
  async collectWorktrees(): Promise<void> {
    const active = new Set([...this.lanes.keys()].flatMap(runId => this.deps.chat.loopRunSessions(runId)));
    for (const worktree of await this.deps.store.worktrees()) {
      if (active.has(worktree.sessionId)) continue;
      const old = this.now() - Date.parse(worktree.createdAt) > RUNNER_MS.worktreeMaxAge;
      if (!old) {
        if (!worktree.finishedAt) continue;
        const open = await this.deps.github
          .findOpenForBranch(worktree.directory, worktree.branch)
          .catch(() => 'unknown');
        if (open) continue;
      }
      try {
        await this.waitIdle(worktree.sessionId);
        if (await this.deps.chat.getSession(worktree.sessionId))
          await this.deps.chat.deleteSession(worktree.sessionId, true);
        else await this.deps.chat.removeWorktrees(worktree.directory, [worktree.path]);
        await this.deps.store.forgetWorktree(worktree.sessionId);
      } catch (err) {
        this.deps.logger.warn(`LOOPS: could not remove worktree ${worktree.path}: ${String(err)}`);
      }
    }
  }

  private async waitIdle(sessionId: string): Promise<void> {
    const deadline = this.now() + RUNNER_MS.stopWait;
    while (this.deps.chat.isSessionBusy(sessionId) && this.now() < deadline) await this.sleep(100);
  }

  state(): Pick<LoopRunnerState, 'lanes' | 'tickets' | 'waitingReason' | 'pendingApprovals' | 'error'> {
    return {
      lanes: { cap: this.cap, busy: this.lanes.size },
      tickets: [...this.lanes.values()].map(lane => ({
        ticketId: lane.claim.ticket.ticketId,
        title: lane.claim.ticket.title,
        loopId: lane.claim.ticket.loopId,
        loopName: lane.claim.ticket.loopName,
        stage: lane.claim.ticket.stage,
        runId: lane.claim.runId,
        sessionId: lane.sessionId,
        startedAt: new Date(lane.startedAt).toISOString(),
      })),
      ...(this.waitingReason ? { waitingReason: this.waitingReason } : {}),
      pendingApprovals: this.pendingApprovals,
      ...(this.error || this.creditStopped()
        ? {
            error:
              this.error ??
              'Out of credits: a loop run stopped at its credit cap. Its tickets wait until tomorrow (UTC).',
          }
        : {}),
    };
  }
}
