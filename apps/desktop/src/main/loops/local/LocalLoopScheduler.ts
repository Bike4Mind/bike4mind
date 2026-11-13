import { randomUUID } from 'node:crypto';
import { effectiveMergePolicy, nextUtcMidnight, startOfUtcDay, type LoopRunOutcome } from '@bike4mind/common';
import {
  advancePatch,
  budgetHeadroom,
  buildLoopQuery,
  buildTriageQuery,
  chooseRunModel,
  LOOP_PROMPT_ANSWERS,
  MIN_ITERATION_CREDITS,
  pacedLanes,
  parseLoopMemory,
  pickReady,
  priorityPatch,
  PRIORITIES_OVER_P2_CAP,
  ticketMovePatch,
  ticketRunLimit,
  untriaged,
} from '@bike4mind/common/loops';
import type { ChatSession, ChatStreamEvent } from '@shared/chat';
import type {
  LocalLoop,
  LocalLoopCapReason,
  LocalLoopEvent,
  LocalLoopStageConfig,
  LocalLoopSummary,
  LocalRun,
  LocalRunStopReason,
  LocalTicket,
} from '@shared/localLoops';
import { parsePullRequestUrl } from '@shared/pullRequest';
import type { GhRunner } from '../../pr/gh';
import { admit, type BudgetSettings, type MachineSample } from '../budget';
import type { SmokeDeps } from '../guards';
import {
  afterMergeChecks,
  CREDIT_STOP,
  mergeLoopPr,
  openLoopSession,
  opensPr,
  pendingReason,
  PR_URL,
  startLoopTurn,
  type LoopMerged,
  type LoopMergeGithub,
  type LoopSessionChat,
} from '../session';
import { localAdmission } from './admission';
import { applyTicketPatch, type LocalLoopStore } from './LocalLoopStore';
import { runTicketTool, type ToolRun } from './ticketTools';

/** The parts of ChatService the scheduler drives; every call is one a user's own click could make. */
export interface LocalSchedulerChat extends LoopSessionChat {
  stop(sessionId: string): void;
  isSessionBusy(sessionId: string): boolean;
  getSession(sessionId: string): Promise<ChatSession | null>;
  removeWorktrees(directory: string, paths?: readonly string[]): Promise<unknown>;
  loopRunOf(sessionId: string): string | undefined;
  loopRunSessions(runId: string): string[];
  endLoopRun(runId: string): void;
}

export interface LocalSchedulerDeps {
  store: LocalLoopStore;
  chat: LocalSchedulerChat;
  killSessionProcesses(sessionId: string): Promise<void> | void;
  /** The machine now and the lane/battery/busy settings it is gated by (shared with LoopRunner). */
  machine(): Promise<{ sample: MachineSample; settings: BudgetSettings }>;
  /** Lanes LoopRunner holds now: one lane pool for both. */
  otherLanes(): number;
  /** The owner's all-loops daily budget, last fetched from the server; undefined when unknown or unset. */
  allLoopsCap(): number | undefined;
  gh: GhRunner;
  github: LoopMergeGithub;
  smoke?: SmokeDeps;
  powerSaveBlocker: { start(type: 'prevent-app-suspension'): number; stop(id: number): void };
  /** A needs-you event the scheduler raised (capped, blocked, a question, an error): tell the owner. */
  alert(loop: LocalLoop, event: LocalLoopEvent): void;
  onChange(): void;
  logger: { warn(message: string): void };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const SCHEDULER_MS = {
  /**
   * Re-check while any loop is live: the machine gate (battery, memory, load) can clear with no event to say so.
   * Every other start (a ticket, a run ending, a reset) ticks at once.
   */
  recheck: 60_000,
} as const;

/** Runs in a row that error before the loop stops in `error`. */
const ERROR_STREAK_LIMIT = 3;

interface Lane {
  run: LocalRun;
  sessionId: string;
  tool: ToolRun;
  /** Credits per message of the run's sessions, as their usage events report it. */
  usage: Map<string, number>;
  /** Over this the run is stopped; undefined: no cap. */
  creditCap?: number;
  /** A triage run: the tickets it was shown. */
  triaged?: string[];
  pending?: string;
  denied: number;
  lastDenied?: string;
  ran: number;
  merged?: LoopMerged;
  prUrl?: string;
  finished: boolean;
}

interface Ended {
  outcome?: LoopRunOutcome;
  stopReason?: LocalRunStopReason;
  reason?: string;
  answer?: string;
}

const UNCOUNTED: ReadonlySet<LocalRunStopReason | LoopRunOutcome | undefined> = new Set([
  'requeued',
  'credit_cap',
  'budget_stopped',
]);

const CAP_TEXT: Record<LocalLoopCapReason, string> = {
  loop_budget: 'daily budget',
  all_loops: 'all-loops budget',
  credits: 'account credits',
};

/**
 * Schedules and runs Desktop-owned loops: the server's loop tick (apps/workers/src/cron/loopScheduler.ts), here
 * and event-driven. A tick runs on every poke (ticket created or moved, run ended, loop resumed, start), at the
 * earliest cap or pacing reset, and every SCHEDULER_MS.recheck while a loop is live. Per live loop it reopens
 * parked tickets, lifts due caps, then fills free lanes: triage first, then ready tickets by priority, each admitted
 * by the machine gate, the budgets and pacing.
 *
 * Only ever stops, kills or deletes sessions it started (and their spawned children, which ChatService marks with
 * the same run id).
 */
export class LocalLoopScheduler {
  private readonly lanes = new Map<string, Lane>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private ticking = false;
  private again = false;
  private previous: MachineSample | undefined;
  private blocker: number | null = null;
  /** loopId -> when pacing next lets it run; in memory only, recomputed every tick. */
  private readonly paced = new Map<string, number>();
  /** Why no run starts now, for the whole machine (lanes busy, battery...). */
  private waitingReason: string | undefined;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: LocalSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  get busy(): number {
    return this.lanes.size;
  }

  /** Re-queue runs a quit or crash cut off, then tick. Call once the store's scope is known (signed in). */
  start(): void {
    this.running = true;
    this.reconcileOpenRuns();
    this.poke();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Something changed that may start a run: tick now. */
  poke(): void {
    if (this.running) void this.tick();
  }

  /**
   * A run with no end in the store was cut off (quit, crash, power loss): its session is gone with the old
   * process, so its ticket goes back to open without counting the run.
   */
  private reconcileOpenRuns(): void {
    const live = new Set(this.lanes.keys());
    for (const run of this.deps.store.openRuns()) {
      if (live.has(run.id)) continue;
      this.endRun(run, { stopReason: 'requeued', reason: 'The app stopped while this run was working' });
    }
  }

  /** One pass over every live loop. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    this.again = false;
    try {
      await this.pass();
    } catch (err) {
      this.deps.logger.warn(`LOOPS: local tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.ticking = false;
      this.arm();
      this.deps.onChange();
      if (this.again && this.running) void this.tick();
    }
  }

  private async pass(): Promise<void> {
    const now = new Date(this.now());
    const loops = this.deps.store.loops();
    for (const loop of loops) this.reconcile(loop, now);
    const live = this.deps.store.loops().filter(loop => loop.status === 'live' && !loop.cappedUntil);
    if (live.length === 0) return;

    const { sample, settings } = await this.deps.machine();
    const previous = this.previous;
    this.previous = sample;
    this.waitingReason = undefined;
    for (const loop of live) {
      const gate = await this.fill(loop, now, sample, previous, settings);
      if (gate) {
        this.waitingReason = gate;
        break;
      }
    }
  }

  /** Reopen tickets parked on closed dependencies (closing epics), block those out of runs, lift a due cap. */
  private reconcile(loop: LocalLoop, now: Date): void {
    const { store } = this.deps;
    store.transaction(() => {
      if (loop.cappedUntil && Date.parse(loop.cappedUntil) <= now.getTime()) {
        const { cappedUntil: _until, capReason: _reason, ...rest } = loop;
        store.putLoop({ ...rest, updatedAt: now.toISOString() });
      }
      const tickets = store.tickets(loop.id);
      const status = new Map(tickets.map(ticket => [ticket.id, ticket.status]));
      const limit = ticketRunLimit(loop.stages);
      for (const ticket of tickets) {
        if (ticket.status === 'blocked' && ticket.blockedOn === 'dependencies') {
          if (!ticket.dependencies.every(id => (status.get(id) ?? 'closed') === 'closed')) continue;
          const move = ticket.epic ? { status: 'closed' as const } : { status: 'open' as const };
          store.putTicket(applyTicketPatch(ticket, ticketMovePatch(loop, ticket, move, 'scheduler'), now));
        } else if (ticket.status === 'open' && ticket.runCount >= limit && !this.runningTicket(ticket.id)) {
          const reason = `Ran ${ticket.runCount} times without finishing; move it to try again`;
          store.putTicket(
            applyTicketPatch(ticket, ticketMovePatch(loop, ticket, { status: 'blocked', reason }, 'scheduler'), now)
          );
          this.raise(loop, { kind: 'blocked', ticketId: ticket.id, reason });
        }
      }
    });
  }

  private runningTicket(ticketId: string): boolean {
    return [...this.lanes.values()].some(lane => lane.run.ticketId === ticketId);
  }

  /**
   * Start what the loop's free lanes, budgets and pacing allow. Returns a machine-wide reason when the machine
   * gate holds every run (then no other loop is tried this pass).
   */
  private async fill(
    loop: LocalLoop,
    now: Date,
    sample: MachineSample,
    previous: MachineSample | undefined,
    settings: BudgetSettings
  ): Promise<string | undefined> {
    const { store } = this.deps;
    this.paced.delete(loop.id);
    const allLoopsCap = this.deps.allLoopsCap();
    for (;;) {
      const fresh = store.loop(loop.id);
      if (!fresh || fresh.status !== 'live' || fresh.cappedUntil) return undefined;
      const mine = [...this.lanes.values()].filter(lane => lane.run.loopId === loop.id);
      const spend = {
        loop: store.spentToday(loop.id, now),
        allLoops: store.spentTodayAllLoops(now),
        ...(allLoopsCap ? { allLoopsCap } : {}),
      };
      const headroom = Math.min(
        budgetHeadroom(fresh.budgetCreditsPerDay, spend.loop, now),
        budgetHeadroom(allLoopsCap, spend.allLoops, now)
      );
      if (mine.length >= fresh.maxConcurrent) return undefined;

      const work = this.nextWork(fresh, now, mine);
      if (!work) return undefined;

      const machine = admit(sample, previous, this.lanes.size + this.deps.otherLanes(), settings);
      if (!machine.ok) return machine.reason;

      // ponytail: the floor price, not the model's; Desktop's catalog carries no max_tokens to price an iteration.
      const admission = localAdmission(fresh, spend, MIN_ITERATION_CREDITS, now);
      if (!admission.ok) {
        if (admission.kind === 'paced') this.paced.set(loop.id, admission.readyAt.getTime());
        else this.cap(fresh, admission.kind === 'user_budget' ? 'all_loops' : 'loop_budget', now);
        return undefined;
      }
      // After admission, so a spent budget caps the loop rather than reading as zero headroom.
      if (mine.length >= pacedLanes(fresh.maxConcurrent, headroom, mine.length)) return undefined;
      // A run that could not open its session leaves its ticket as it was: try again next tick, not now.
      if (!(await this.startRun(fresh, work, headroom, admission.creditCap, now))) return undefined;
    }
  }

  /** The loop's next run: a triage run while tickets wait for a priority, else its first ready ticket. */
  private nextWork(
    loop: LocalLoop,
    now: Date,
    mine: Lane[]
  ): { kind: 'triage'; tickets: LocalTicket[] } | { kind: 'ticket'; ticket: LocalTicket } | null {
    const tickets = this.deps.store.tickets(loop.id);
    const waiting = untriaged(tickets).slice(0, 20);
    if (waiting.length > 0 && !mine.some(lane => lane.run.kind === 'triage'))
      return { kind: 'triage', tickets: waiting };
    const status = new Map(tickets.map(ticket => [ticket.id, ticket.status]));
    const limit = ticketRunLimit(loop.stages);
    const p2Left =
      loop.p2RunsPerDay === undefined
        ? Infinity
        : loop.p2RunsPerDay -
          this.deps.store.runs(loop.id, startOfUtcDay(now).toISOString()).filter(run => run.priority === 'p2').length;
    const ready = pickReady(
      tickets.filter(ticket => ticket.runCount < limit && !this.runningTicket(ticket.id)),
      loop.stages,
      id => status.get(id),
      p2Left > 0 ? undefined : PRIORITIES_OVER_P2_CAP
    );
    return ready[0] ? { kind: 'ticket', ticket: ready[0] } : null;
  }

  /** Hold the loop until the next UTC midnight, when its budgets reset, and tell the owner. */
  private cap(loop: LocalLoop, reason: LocalLoopCapReason, now: Date): void {
    const until = nextUtcMidnight(now);
    this.deps.store.transaction(() => {
      this.deps.store.putLoop({
        ...loop,
        cappedUntil: until.toISOString(),
        capReason: reason,
        updatedAt: now.toISOString(),
      });
      this.raise(loop, { kind: 'capped', reason: `Capped until ${until.toISOString()} (${CAP_TEXT[reason]})` });
    });
  }

  private raise(loop: LocalLoop, event: Pick<LocalLoopEvent, 'kind' | 'reason' | 'ticketId' | 'runId'>): void {
    const stored = this.deps.store.putEvent({
      id: randomUUID(),
      loopId: loop.id,
      ...event,
      createdAt: new Date(this.now()).toISOString(),
    });
    this.deps.alert(loop, stored);
  }

  private async startRun(
    loop: LocalLoop,
    work: NonNullable<ReturnType<LocalLoopScheduler['nextWork']>>,
    headroom: number,
    creditCap: number | undefined,
    now: Date
  ): Promise<boolean> {
    const { store } = this.deps;
    const ticket = work.kind === 'ticket' ? work.ticket : undefined;
    const stage: Partial<LocalLoopStageConfig> = loop.stageConfig.find(entry => entry.stage === ticket?.stage) ?? {};
    const choice = ticket
      ? chooseRunModel(
          loop,
          stage,
          {
            runsAfterClaim: ticket.runCount + 1,
            ...(ticket.lastRunFallback !== undefined ? { lastRunFallback: ticket.lastRunFallback } : {}),
            ...(ticket.lastRunAdvanced !== undefined ? { lastRunAdvanced: ticket.lastRunAdvanced } : {}),
          },
          ticketRunLimit(loop.stages),
          headroom
        )
      : { model: loop.model, fallback: false };
    const run: LocalRun = {
      id: randomUUID(),
      loopId: loop.id,
      kind: work.kind,
      ...(ticket ? { ticketId: ticket.id } : {}),
      ...(ticket?.priority ? { priority: ticket.priority } : {}),
      model: choice.model,
      fallback: choice.fallback,
      startedAt: now.toISOString(),
      credits: 0,
    };
    store.transaction(() => {
      store.putRun(run);
      if (ticket) {
        const claimed = applyTicketPatch(ticket, { status: 'in_progress', runCount: ticket.runCount + 1 }, now);
        store.putTicket({ ...claimed, lastRunModel: choice.model, lastRunFallback: choice.fallback });
      }
    });

    const opened = await openLoopSession(this.deps.chat, {
      directory: loop.directory,
      approvalMode: loop.approvalMode,
      model: choice.model,
    });
    if (!opened.ok) {
      this.endRun(
        run,
        opened.outcome === 'failed'
          ? { outcome: 'failed', reason: opened.reason }
          : { stopReason: 'requeued', reason: opened.reason }
      );
      return false;
    }
    const lane: Lane = {
      run: store.putRun({ ...run, sessionId: opened.sessionId }),
      sessionId: opened.sessionId,
      tool: { loopId: loop.id, runId: run.id, creates: 0, ...(ticket ? { ticketId: ticket.id } : {}) },
      usage: new Map(),
      ...(creditCap !== undefined ? { creditCap } : {}),
      ...(work.kind === 'triage' ? { triaged: work.tickets.map(t => t.id) } : {}),
      denied: 0,
      ran: 0,
      finished: false,
    };
    this.lanes.set(run.id, lane);
    this.updateBlocker();

    const prompt = ticket
      ? buildLoopQuery(loop.goal, loop.memory, {
          item: { id: ticket.id, title: ticket.title, description: ticket.description, stage: ticket.stage },
          stages: loop.stages,
          answers: this.answers(loop.id, ticket.id),
          ...(stage.instructions ? { instructions: stage.instructions } : {}),
        })
      : buildTriageQuery(loop, work.kind === 'triage' ? work.tickets : []);
    const started = await startLoopTurn(this.deps.chat, opened.sessionId, prompt, {
      kind: 'local-loop',
      loopId: loop.id,
      ...(ticket ? { ticketId: ticket.id } : {}),
      runId: run.id,
      summary: ticket?.title ?? `Triage ${work.kind === 'triage' ? work.tickets.length : 0} tickets`,
    });
    if (!started.ok) await this.finish(lane, { outcome: 'failed', reason: started.error });
    return true;
  }

  /** The owner's answers to the ticket's questions, newest first, for its next run's prompt. */
  private answers(loopId: string, ticketId: string): { question: string; note: string }[] {
    return this.deps.store
      .events(loopId)
      .filter(
        event => event.ticketId === ticketId && event.kind === 'asked' && event.resolution?.outcome === 'answered'
      )
      .slice(0, LOOP_PROMPT_ANSWERS)
      .map(event => ({ question: event.reason, note: event.resolution?.note ?? '' }));
  }

  private laneOf(sessionId: string): Lane | undefined {
    const runId = this.deps.chat.loopRunOf(sessionId);
    if (runId) return this.lanes.get(runId);
    return [...this.lanes.values()].find(lane => lane.sessionId === sessionId);
  }

  /** Whether the session works for one of this scheduler's runs. */
  owns(sessionId: string): boolean {
    return this.laneOf(sessionId) !== undefined;
  }

  /** Every chat stream event, from the main-process observer. */
  observe(event: ChatStreamEvent): void {
    if (!('sessionId' in event)) return;
    const lane = this.laneOf(event.sessionId);
    if (!lane || lane.finished) return;
    const pending = pendingReason(event);
    if (pending) lane.pending = pending;
    if (event.type === 'tool-end' && event.call.preview && opensPr(event.call)) this.notePr(lane, event.call.preview);
    if ((event.type === 'usage' || event.type === 'done') && event.usage)
      this.spend(lane, event.messageId, event.usage.creditsUsed);
    if (lane.finished || event.sessionId !== lane.sessionId) return;
    if (event.type === 'tool-end' && event.call.status === 'denied') {
      lane.denied++;
      lane.lastDenied = event.call.approvalDetail ? lane.pending : (event.call.error ?? lane.pending);
    }
    if (event.type === 'tool-end' && (event.call.status === 'done' || event.call.status === 'error')) lane.ran++;
    if (event.type === 'error' && CREDIT_STOP.test(event.message)) {
      const loop = this.deps.store.loop(lane.run.loopId);
      if (loop) this.cap(loop, 'credits', new Date(this.now()));
      void this.finish(lane, { outcome: 'budget_stopped', reason: 'Out of credits' });
    } else if (event.type === 'error') void this.finish(lane, { outcome: 'failed', reason: event.message });
    if (event.type !== 'done') return;
    if (event.stopReason === 'aborted')
      void this.finish(lane, { outcome: 'blocked', reason: 'Stopped on the desktop' });
    else void this.turnDone(lane, event.content);
  }

  /**
   * The run's spend so far, from its sessions' usage events. ponytail: usage lands per model response, so the
   * per-run cap is enforced at those boundaries, not mid-response.
   */
  private spend(lane: Lane, messageId: string, credits: number | undefined): void {
    if (credits === undefined) return;
    lane.usage.set(messageId, credits);
    const total = [...lane.usage.values()].reduce((sum, value) => sum + value, 0);
    if (total === lane.run.credits) return;
    lane.run = this.deps.store.putRun({ ...lane.run, credits: total });
    if (lane.creditCap !== undefined && total > lane.creditCap)
      void this.finish(lane, { stopReason: 'credit_cap', reason: 'Reached its credit cap for this run' });
  }

  private notePr(lane: Lane, text: string): void {
    const repo = this.deps.store.loop(lane.run.loopId)?.repo;
    for (const [url] of text.matchAll(PR_URL)) {
      const ref = parsePullRequestUrl(url);
      if (ref && (!repo || `${ref.owner}/${ref.repo}`.toLowerCase() === repo)) lane.prUrl = ref.url;
    }
  }

  /** ApprovalGate closed a card in a run session: nobody can answer it, so the owner gets the ticket. */
  unattended(sessionId: string): void {
    const lane = this.laneOf(sessionId);
    if (lane && !lane.finished)
      void this.finish(lane, { outcome: 'blocked', reason: lane.pending ?? 'Needs approval' });
  }

  /** A run's loop_ticket_* call. */
  ticketTool(sessionId: string, tool: string, input: Record<string, unknown>): string {
    const lane = this.laneOf(sessionId);
    if (!lane) throw new Error('This session is not working for a loop.');
    const result = runTicketTool(this.deps.store, lane.tool, tool, input, (ticket, question) => {
      const loop = this.deps.store.loop(ticket.loopId);
      if (loop) this.raise(loop, { kind: 'asked', ticketId: ticket.id, runId: lane.run.id, reason: question });
    });
    this.poke();
    return result;
  }

  private async turnDone(lane: Lane, answer: string): Promise<void> {
    // A spawned child still working reports back to this session, which then takes another turn.
    const children = this.deps.chat.loopRunSessions(lane.run.id).filter(id => id !== lane.sessionId);
    if (children.some(id => this.deps.chat.isSessionBusy(id))) return;
    if (lane.finished) return;
    lane.finished = true;
    if (lane.denied > 0 && lane.ran === 0) {
      await this.finish(
        lane,
        { outcome: 'blocked', reason: `Every action was declined: ${lane.lastDenied ?? 'no detail'}`, answer },
        true
      );
      return;
    }
    const loop = this.deps.store.loop(lane.run.loopId);
    const ticket = lane.run.ticketId ? this.deps.store.ticket(lane.run.ticketId) : null;
    const stage = loop?.stageConfig.find(entry => entry.stage === ticket?.stage);
    const checked = await afterMergeChecks(
      { gh: this.deps.gh, ...(this.deps.smoke ? { smoke: this.deps.smoke } : {}), now: this.now, sleep: this.sleep },
      lane.merged,
      stage,
      loop?.directory ?? '',
      async () => (await this.deps.chat.getSession(lane.sessionId))?.project?.workingDirectory ?? loop?.directory ?? ''
    ).catch((err: unknown) => ({ ok: false as const, reason: `post-merge check failed: ${String(err)}` }));
    await this.finish(
      lane,
      checked.ok ? { outcome: 'done', answer } : { outcome: 'blocked', reason: checked.reason, answer },
      true
    );
  }

  /** loop_merge_pr in a Desktop loop run: the stage's policy, or block the ticket with why not. */
  async merge(sessionId: string, prUrl: string): Promise<string> {
    const lane = this.laneOf(sessionId);
    if (!lane || lane.finished || !lane.run.ticketId) throw new Error('This session is not working on a loop ticket.');
    const ref = parsePullRequestUrl(prUrl);
    if (!ref) throw new Error(`Not a GitHub pull request URL: ${prUrl}`);
    const loop = this.deps.store.loop(lane.run.loopId);
    const ticket = this.deps.store.ticket(lane.run.ticketId);
    const stage = loop?.stageConfig.find(entry => entry.stage === ticket?.stage);
    const result = await mergeLoopPr({ github: this.deps.github, gh: this.deps.gh }, ref, {
      ...(loop?.repo ? { repo: loop.repo } : {}),
      mergePolicy: effectiveMergePolicy(stage?.mergePolicy),
      ...(stage?.holdLabels ? { holdLabels: stage.holdLabels } : {}),
    });
    if (!result.ok) {
      void this.finish(lane, { outcome: 'blocked', reason: result.reason });
      throw new Error(`${result.reason} The ticket is handed to the user; stop here.`);
    }
    lane.merged = result.merged;
    lane.prUrl = ref.url;
    return result.message;
  }

  /** Record the run's end once, stop what is still going, free the lane, and tick. */
  private async finish(lane: Lane, ended: Ended, force = false): Promise<void> {
    if (lane.finished && !force) return;
    lane.finished = true;
    const sessions = this.deps.chat.loopRunSessions(lane.run.id);
    for (const sessionId of sessions) this.deps.chat.stop(sessionId);
    await Promise.all(
      sessions.map(sessionId => Promise.resolve(this.deps.killSessionProcesses(sessionId)).catch(() => undefined))
    );
    // A run stopped after it opened a PR would open a second one if re-run: hand the ticket to the owner instead.
    if (lane.prUrl && UNCOUNTED.has(ended.stopReason ?? ended.outcome)) {
      ended = {
        outcome: 'blocked',
        reason: `${ended.reason ?? 'Stopped'} after opening ${lane.prUrl}; continue that PR`,
      };
    }
    this.endRun(lane.run, ended, lane);
    this.lanes.delete(lane.run.id);
    this.updateBlocker();
    await this.retire(lane).catch(err => this.deps.logger.warn(`LOOPS: local cleanup failed: ${String(err)}`));
    this.poke();
  }

  /** Fold a run's end into the store: the run, its ticket, the loop's memory and error streak. */
  private endRun(run: LocalRun, ended: Ended, lane?: Lane): void {
    const { store } = this.deps;
    const now = new Date(this.now());
    store.transaction(() => {
      const current = store.run(run.id) ?? run;
      store.putRun({
        ...current,
        endedAt: now.toISOString(),
        ...(ended.outcome ? { outcome: ended.outcome } : {}),
        ...(ended.stopReason ? { stopReason: ended.stopReason } : {}),
        ...(ended.reason ? { reason: ended.reason.slice(0, 1000) } : {}),
      });
      let loop = store.loop(run.loopId);
      if (!loop) return;
      const failed = ended.outcome === 'failed';
      const errorStreak = failed ? loop.errorStreak + 1 : 0;
      loop = {
        ...loop,
        errorStreak,
        ...(ended.answer && run.kind === 'ticket' ? { memory: parseLoopMemory(ended.answer, loop.memory) } : {}),
        ...(errorStreak >= ERROR_STREAK_LIMIT && {
          status: 'error' as const,
          error: `${errorStreak} runs in a row failed; last: ${ended.reason ?? 'unknown'}`,
        }),
        updatedAt: now.toISOString(),
      };
      store.putLoop(loop);
      if (errorStreak === ERROR_STREAK_LIMIT) this.raise(loop, { kind: 'error', runId: run.id, reason: loop.error! });

      if (run.kind === 'triage') {
        // As the server's defaultUntriaged: a ticket the triage run was shown and left untriaged gets p2.
        for (const id of lane?.triaged ?? []) {
          const ticket = store.ticket(id);
          if (ticket && ticket.status === 'open' && !ticket.priority && !ticket.epic)
            store.putTicket(applyTicketPatch(ticket, priorityPatch('p2', 'agent', now), now));
        }
        return;
      }
      const ticket = run.ticketId ? store.ticket(run.ticketId) : null;
      // A ticket the run itself moved (blocked, closed, asked about) is where the run put it.
      if (!ticket || ticket.status !== 'in_progress') return;
      if (UNCOUNTED.has(ended.stopReason ?? ended.outcome)) {
        store.putTicket(applyTicketPatch(ticket, { status: 'open', runCount: Math.max(0, ticket.runCount - 1) }, now));
        return;
      }
      if (ended.outcome === 'done') {
        const history = ticket.stageHistory.map(entry => ({ ...entry, at: new Date(entry.at) }));
        const patch = advancePatch(loop, { stage: ticket.stage, stageHistory: history }, new Date(run.startedAt));
        const advanced = applyTicketPatch(ticket, patch, now);
        store.putTicket({
          ...advanced,
          lastRunAdvanced: advanced.stage !== ticket.stage || advanced.status === 'closed',
        });
        return;
      }
      const reason = ended.reason ?? 'The run stopped';
      store.putTicket({
        ...applyTicketPatch(ticket, ticketMovePatch(loop, ticket, { status: 'blocked', reason }, 'scheduler'), now),
        lastRunAdvanced: false,
      });
      this.raise(loop, { kind: 'blocked', ticketId: ticket.id, runId: run.id, reason });
    });
  }

  /**
   * End the run's marking, so its sessions become ordinary conversations, and remove the worktrees of a run that
   * opened no PR. ponytail: a worktree with a PR stays until the owner deletes its session; G5 can collect it.
   */
  private async retire(lane: Lane): Promise<void> {
    const sessions = this.deps.chat.loopRunSessions(lane.run.id);
    this.deps.chat.endLoopRun(lane.run.id);
    if (lane.prUrl) return;
    for (const sessionId of sessions) {
      const project = (await this.deps.chat.getSession(sessionId))?.project;
      if (!project?.workspace || !project.workspaceBranch) continue;
      await this.waitIdle(sessionId);
      await this.deps.chat.removeWorktrees(project.directory, [project.workingDirectory]);
    }
  }

  private async waitIdle(sessionId: string): Promise<void> {
    const deadline = this.now() + 10_000;
    while (this.deps.chat.isSessionBusy(sessionId) && this.now() < deadline) await this.sleep(100);
  }

  /** Quit: stop every run now; their tickets go back uncounted. */
  async releaseAll(): Promise<void> {
    this.stop();
    await Promise.all(
      [...this.lanes.values()].map(lane => this.finish(lane, { stopReason: 'requeued', reason: 'The app quit' }))
    );
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.running) return;
    const loops = this.deps.store.loops().filter(loop => loop.status === 'live');
    if (loops.length === 0) return;
    const now = this.now();
    const wakes = [
      now + SCHEDULER_MS.recheck,
      ...loops.flatMap(loop => (loop.cappedUntil ? [Date.parse(loop.cappedUntil)] : [])),
      ...this.paced.values(),
    ];
    this.timer = setTimeout(() => void this.tick(), Math.max(0, Math.min(...wakes) - now));
  }

  private updateBlocker(): void {
    if (this.lanes.size > 0 && this.blocker === null) {
      this.blocker = this.deps.powerSaveBlocker.start('prevent-app-suspension');
    } else if (this.lanes.size === 0 && this.blocker !== null) {
      this.deps.powerSaveBlocker.stop(this.blocker);
      this.blocker = null;
    }
  }

  /** A loop for the list: lanes, spend, needs-you count, and why it is idle when it is. */
  summary(loop: LocalLoop): LocalLoopSummary {
    const now = new Date(this.now());
    const lanesBusy = [...this.lanes.values()].filter(lane => lane.run.loopId === loop.id).length;
    const tickets = this.deps.store.tickets(loop.id);
    const needsYou = tickets.filter(ticket => ticket.status === 'blocked' && !ticket.blockedOn).length;
    const paced = this.paced.get(loop.id);
    const idleReason =
      loop.status === 'paused'
        ? 'paused'
        : loop.status === 'error'
          ? `error: ${loop.error ?? 'unknown'}`
          : loop.cappedUntil
            ? `capped until ${loop.cappedUntil} (${CAP_TEXT[loop.capReason ?? 'loop_budget']})`
            : lanesBusy > 0
              ? undefined
              : paced
                ? `paced until ${new Date(paced).toISOString()}`
                : this.waitingReason
                  ? `waiting: ${this.waitingReason}`
                  : needsYou > 0
                    ? 'waiting on you'
                    : 'no work';
    return {
      loop,
      lanesBusy,
      spentToday: this.deps.store.spentToday(loop.id, now),
      needsYou,
      ...(idleReason ? { idleReason } : {}),
    };
  }
}
