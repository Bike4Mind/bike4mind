import {
  LOOP_RUN_OUTCOMES,
  type ILoop,
  type ILoopDirective,
  type ILoopEvent,
  type ILoopStageStats,
  type ILoopStats,
  type IWorkItem,
  type IWorkItemStageEntry,
  type LoopRunOutcome,
  type LoopStatsWindow,
  WORK_ITEM_STAGE_HISTORY_MAX,
} from '@bike4mind/common';
import {
  agentExecutionRepository,
  loopDirectiveRepository,
  loopEventRepository,
  workItemRepository,
  type LoopStatsRun,
} from '@bike4mind/database';
import { median } from '@server/qa/runInsights';
import { UNSURE_PREFIX } from './loopTickets';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Runs expire after 90 days (the AgentExecution TTL), so an older baseline has no run data. */
const RUN_TTL_MS = 90 * DAY_MS;
const TOP_TOOLS = 5;
/** ponytail: events and directives read per stats request; a busier loop's eras and directive counts are a prefix. */
const LOOP_STATS_EVENTS = 500;

export interface LoopStatsInput {
  loop: Pick<ILoop, 'stages' | 'budgetCreditsPerDay'>;
  days: LoopStatsWindow;
  now: Date;
  /** The loop's top-level runs since `now - 2 * days` (window plus baseline). */
  runs: LoopStatsRun[];
  /** `listForLoopStats` since `now - 2 * days`. */
  tickets: IWorkItem[];
  /** `config_changed` events since `now - days`. */
  eras: ILoopEvent[];
  /** The loop's unresolved `unsure` events. */
  unresolved: ILoopEvent[];
  directives: ILoopDirective[];
  truncated: boolean;
}

const time = (date: Date | string | undefined): number => (date ? new Date(date).getTime() : NaN);
const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const inRange = (ms: number, from: number, to: number): boolean => ms >= from && ms < to;

/**
 * A ticket's moves in its current loop: the entries from its last hand-off on, in the loop's stages, with repeats of
 * one stage collapsed (a read-to-write race can write one twice). A ticket older than the history counts as having
 * entered its current stage at `createdAt`.
 */
export function ticketSegment(ticket: IWorkItem, stages: string[]): IWorkItemStageEntry[] {
  const history = ticket.stageHistory ?? [];
  let start = 0;
  history.forEach((entry, index) => {
    if (entry.by === 'handoff') start = index;
  });
  const segment: IWorkItemStageEntry[] = [];
  for (const entry of history.slice(start)) {
    if (!stages.includes(entry.stage) || segment.at(-1)?.stage === entry.stage) continue;
    segment.push(entry);
  }
  if (segment.length === 0 && ticket.stage) segment.push({ stage: ticket.stage, at: ticket.createdAt, by: 'owner' });
  return segment;
}

const topTools = (counts: Map<string, number>) =>
  [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_TOOLS)
    .map(([tool, count]) => ({ tool, count }));

/** The `GET /api/loops/:id/stats` payload, computed in memory from what the route read. Durations in ms. */
export function computeLoopStats(input: LoopStatsInput): ILoopStats {
  const { loop, days, now, runs, tickets } = input;
  const stages = loop.stages;
  const to = now.getTime();
  const from = to - days * DAY_MS;
  const baseFrom = from - days * DAY_MS;
  const inWindow = (ms: number) => inRange(ms, from, to + 1);
  const inBaseline = (ms: number) => inRange(ms, baseFrom, from);

  const segments = new Map(tickets.map(ticket => [ticket.id, ticketSegment(ticket, stages)]));
  const closedIn = (inside: (ms: number) => boolean) =>
    tickets.filter(ticket => ticket.status === 'closed' && inside(time(ticket.closedAt)));
  // A full history may have dropped the ticket's first entries, so its cycle starts at `createdAt` (unless it
  // still holds the hand-off that brought it into this loop).
  const cycleStart = (ticket: IWorkItem) => {
    const first = segments.get(ticket.id)![0];
    const full = (ticket.stageHistory?.length ?? 0) >= WORK_ITEM_STAGE_HISTORY_MAX && first?.by !== 'handoff';
    return time(full ? ticket.createdAt : (first?.at ?? ticket.createdAt));
  };
  const cycleMs = (ticket: IWorkItem) => time(ticket.closedAt) - cycleStart(ticket);
  const [closed, closedBefore] = [closedIn(inWindow), closedIn(inBaseline)];
  const [windowRuns, baselineRuns] = [
    runs.filter(run => inWindow(time(run.createdAt))),
    runs.filter(run => inBaseline(time(run.createdAt))),
  ];
  const credits = (list: LoopStatsRun[]) => list.reduce((sum, run) => sum + (run.totalCreditsUsed ?? 0), 0);
  const perClosed = (list: LoopStatsRun[], count: number) => (count > 0 ? credits(list) / count : null);

  // By stage: runs stamped with their stage, then the moves out of the tickets' histories.
  const byStage = new Map<string, ILoopStageStats & { runMs: number[]; stayMs: number[] }>(
    stages.map(stage => [
      stage,
      {
        stage,
        runs: 0,
        outcomes: Object.fromEntries(LOOP_RUN_OUTCOMES.map(outcome => [outcome, 0])) as Record<LoopRunOutcome, number>,
        retried: 0,
        medianRunMs: null,
        credits: 0,
        medianTimeInStageMs: null,
        entered: 0,
        backMoves: 0,
        bounces: 0,
        toolsUnavailable: [],
        toolsErrored: [],
        runMs: [],
        stayMs: [],
      },
    ])
  );
  const unavailable = new Map<string, Map<string, number>>();
  const errored = new Map<string, Map<string, number>>();
  const tally = (into: Map<string, Map<string, number>>, stage: string, names: string[] = []) => {
    const counts = into.get(stage) ?? new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    into.set(stage, counts);
  };
  for (const run of windowRuns) {
    const row = run.loopStage ? byStage.get(run.loopStage) : undefined;
    if (!row) continue;
    row.runs++;
    if (run.loopOutcome) row.outcomes[run.loopOutcome]++;
    if ((run.loopAttempt ?? 1) > 1) row.retried++;
    row.credits += run.totalCreditsUsed ?? 0;
    if (run.completedAt) row.runMs.push(time(run.completedAt) - time(run.createdAt));
    tally(unavailable, row.stage, run.toolsUnavailable);
    tally(errored, row.stage, run.toolsErrored);
  }
  const index = (stage: string) => stages.indexOf(stage);
  for (const ticket of tickets) {
    const segment = segments.get(ticket.id)!;
    segment.forEach((entry, i) => {
      const row = byStage.get(entry.stage)!;
      const at = time(entry.at);
      if (inWindow(at) && (ticket.stageHistory?.length ?? 0) > 0) row.entered++;
      const next = segment[i + 1];
      // The last stage of a closed ticket is where it ended, not a wait.
      const end = next ? time(next.at) : ticket.status === 'closed' ? NaN : to;
      if (inWindow(end)) row.stayMs.push(end - at);
      // A back-move counts against the stage it left.
      if (next && inWindow(time(next.at)) && index(next.stage) < index(entry.stage)) {
        row.backMoves++;
        if (next.by === 'run' || next.by === 'scheduler') row.bounces++;
      }
    });
  }

  // Cumulative flow: each ticket's stage at the end of each UTC day of the window.
  const daily: ILoopStats['daily'] = [];
  // ponytail: a ticket closed before the baseline window is not read, so the last stage's band undercounts.
  const today = Math.floor(to / DAY_MS) * DAY_MS;
  const firstDay = today - (days - 1) * DAY_MS;
  for (let start = firstDay; start <= today; start += DAY_MS) {
    const day = start + DAY_MS;
    // The first bar also takes the window's head before its midnight, so the bars add up to the headline.
    const lo = start === firstDay ? from : start;
    const counts: Record<string, number> = Object.fromEntries(stages.map(stage => [stage, 0]));
    for (const ticket of tickets) {
      const stage = segments
        .get(ticket.id)!
        .filter(entry => time(entry.at) < day)
        .at(-1)?.stage;
      if (stage) counts[stage]++;
    }
    daily.push({
      day: dayKey(start),
      closed: closed.filter(ticket => inRange(time(ticket.closedAt), lo, day)).length,
      credits: credits(windowRuns.filter(run => inRange(time(run.createdAt), lo, day))),
      budget: loop.budgetCreditsPerDay ?? null,
      stages: counts,
    });
  }

  const costByModel = new Map<string, { model: string; runs: number; credits: number }>();
  for (const run of windowRuns) {
    const row = costByModel.get(run.model) ?? { model: run.model, runs: 0, credits: 0 };
    row.runs++;
    row.credits += run.totalCreditsUsed ?? 0;
    costByModel.set(run.model, row);
  }

  // Waiting on the owner: a block with no condition the scheduler tests, or an open question.
  const byId = new Map(tickets.map(ticket => [ticket.id, ticket]));
  const humanQueue: ILoopStats['humanQueue'] = [];
  const queued = new Set<string>();
  for (const event of input.unresolved) {
    const ticket = event.workItemId ? byId.get(event.workItemId) : undefined;
    if (event.workItemId && queued.has(event.workItemId)) continue;
    if (event.workItemId) queued.add(event.workItemId);
    humanQueue.push({
      ...(event.workItemId && { workItemId: event.workItemId }),
      title: ticket?.title ?? event.ticketTitle ?? event.reason,
      ...(ticket?.stage && { stage: ticket.stage }),
      reason: 'unsure',
      since: new Date(event.requestedAt).toISOString(),
      executionId: event.executionId,
    });
  }
  for (const ticket of tickets) {
    if (ticket.status !== 'blocked' || ticket.blockedOn || queued.has(ticket.id)) continue;
    humanQueue.push({
      workItemId: ticket.id,
      title: ticket.title,
      ...(ticket.stage && { stage: ticket.stage }),
      reason: ticket.statusReason?.startsWith(UNSURE_PREFIX) ? 'unsure' : 'blocked',
      since: new Date(ticket.updatedAt).toISOString(),
      ...(ticket.executionId && { executionId: ticket.executionId }),
    });
  }
  humanQueue.sort((a, b) => a.since.localeCompare(b.since));

  const replies = input.directives.flatMap(directive => directive.replies).filter(reply => inWindow(time(reply.at)));
  const historyStarts = tickets.map(ticket => time(ticket.stageHistory?.[0]?.at)).filter(ms => !Number.isNaN(ms));
  const preHistory = tickets.some(ticket => !ticket.stageHistory?.length);

  return {
    days,
    from: new Date(from).toISOString(),
    to: now.toISOString(),
    headline: {
      throughputPerDay: { value: closed.length / days, baseline: closedBefore.length / days },
      medianCycleMs: { value: median(closed.map(cycleMs)), baseline: median(closedBefore.map(cycleMs)) },
      creditsPerClosed: {
        value: perClosed(windowRuns, closed.length),
        baseline: baseFrom < to - RUN_TTL_MS ? null : perClosed(baselineRuns, closedBefore.length),
      },
      needsYou: { value: humanQueue.length, baseline: null },
    },
    byStage: [...byStage.values()].map(({ runMs, stayMs, ...row }) => ({
      ...row,
      medianRunMs: median(runMs),
      medianTimeInStageMs: median(stayMs),
      toolsUnavailable: topTools(unavailable.get(row.stage) ?? new Map()),
      toolsErrored: topTools(errored.get(row.stage) ?? new Map()),
    })),
    daily,
    eras: input.eras
      .filter(event => inWindow(time(event.requestedAt)))
      .map(event => ({ at: new Date(event.requestedAt).toISOString(), reason: event.reason })),
    costByModel: [...costByModel.values()].sort((a, b) => b.credits - a.credits),
    humanQueue,
    ratings: {
      up: closed.filter(ticket => ticket.ownerRating?.value === 'up').length,
      down: closed.filter(ticket => ticket.ownerRating?.value === 'down').length,
      unrated: closed.filter(ticket => !ticket.ownerRating).length,
    },
    directives: {
      pushedBack: replies.filter(reply => reply.by === 'worker' && reply.outcome === 'pushed_back').length,
      overruled: replies.filter(reply => reply.by === 'owner' && reply.outcome === 'overruled').length,
    },
    ...(preHistory &&
      historyStarts.length > 0 && { historyBegins: new Date(Math.min(...historyStarts)).toISOString() }),
    truncated: input.truncated,
  };
}

/**
 * Reads what `computeLoopStats` needs and computes it. Shared by the stats and coach routes; `runsSince` reads runs
 * further back than the window and its baseline (the coach's trial baseline), which the stats ignore.
 */
export async function readLoopStats(
  loop: Pick<ILoop, 'id' | 'stages' | 'budgetCreditsPerDay'>,
  userId: string,
  days: LoopStatsWindow,
  now: Date,
  runsSince?: Date
): Promise<{ stats: ILoopStats; runs: LoopStatsRun[]; tickets: IWorkItem[] }> {
  const since = new Date(now.getTime() - 2 * days * DAY_MS);
  const [runs, tickets, eras, unresolved, directives] = await Promise.all([
    agentExecutionRepository.listLoopRunsSince(loop.id, runsSince && runsSince < since ? runsSince : since),
    workItemRepository.listForLoopStats(userId, loop.id, since),
    loopEventRepository.listForLoopSince(
      userId,
      loop.id,
      new Date(now.getTime() - days * DAY_MS),
      ['config_changed'],
      LOOP_STATS_EVENTS
    ),
    loopEventRepository.listUnresolvedUnsure(userId, loop.id, LOOP_STATS_EVENTS),
    loopDirectiveRepository.listToLoop(userId, loop.id, LOOP_STATS_EVENTS),
  ]);
  const stats = computeLoopStats({
    loop,
    days,
    now,
    runs: runs.runs,
    tickets: tickets.items,
    eras,
    unresolved,
    directives,
    truncated: runs.truncated || tickets.truncated,
  });
  return { stats, runs: runs.runs, tickets: tickets.items };
}
