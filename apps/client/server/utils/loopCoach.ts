import isEqual from 'lodash/isEqual';
import {
  LOOP_COACH_KINDS,
  stageConfigOf,
  type ILoop,
  type ILoopCoachTrial,
  type ILoopStageConfig,
  type ILoopStats,
  type IWorkItem,
  type LoopCoachSuggestion,
  type LoopCoachTrialSide,
  type ModelInfo,
} from '@bike4mind/common';
import {
  INTERVAL_MAX,
  validateLoopBudget,
  validateLoopInterval,
  validateLoopStageConfig,
  validateLoopStages,
  validateLoopTools,
} from '@bike4mind/common/loops';
import type { LoopStatsRun } from '@bike4mind/database';
import { median } from '@server/qa/runInsights';
import { ticketSegment } from './loopStats';

const DAY_MS = 24 * 60 * 60 * 1000;

/** ponytail: fixed thresholds; make per-loop only if owners ask. */
export const COACH = {
  windowDays: 30,
  dismissDays: 30,
  maxShown: 10,
  removeStage: { minRuns: 20, doneRate: 0.95 },
  addStage: { minRuns: 10, unsureRate: 0.3, reasons: 3, reasonChars: 80 },
  cheaperModel: { minRated: 10, upRate: 0.9, doneRate: 0.8, maxPriceRatio: 0.75 },
  strongerModel: { minRuns: 10, downRate: 0.3, failRate: 0.3 },
  addTool: { minRuns: 3 },
  failingTool: { minRuns: 10, rate: 0.3 },
  slowerSchedule: { minRuns: 20, idleRate: 0.5 },
  raiseBudget: { days: 7, minDays: 4, factor: 1.25 },
  lowerBudget: { minDays: 14, peakRate: 0.5, factor: 1.5 },
  trial: { min: 5, max: 50, default: 10 },
} as const;

export const COACH_REFINE_INSTRUCTIONS =
  'Clarify requirements for the next stage; ask the owner when something is missing.';

export interface CoachInput {
  loop: ILoop;
  /** `computeLoopStats` over `COACH.windowDays`. */
  stats: ILoopStats;
  /** The loop's runs; only those in the window count. */
  runs: LoopStatsRun[];
  /** `listForLoopStats` over at least the window. */
  tickets: IWorkItem[];
  /** Short reasons of the window's unsure events, newest first, by the stage of their run. */
  unsureReasons: Record<string, string[]>;
  /** The owner's available models, priced (`getCallerModelList`). */
  models: ModelInfo[];
  /** A built-in tool the owner can use (`resolveToolAvailability`). */
  canAddTool: (tool: string) => boolean;
  now: Date;
}

const pct = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

/** Input plus output of the lowest pricing tier, per token; null when unpriced. */
export function tokenPrice(model: ModelInfo | undefined): number | null {
  if (!model?.pricing) return null;
  const tiers = Object.keys(model.pricing)
    .map(Number)
    .sort((a, b) => a - b);
  const tier = model.pricing[tiers[0]];
  return tier ? tier.input + tier.output : null;
}

/** The loop's stageConfig with `stage`'s entry changed by `change` (added when missing). */
function withStage(loop: ILoop, stage: string, change: (entry: ILoopStageConfig) => ILoopStageConfig) {
  const config = loop.stageConfig ?? [];
  const current = config.find(entry => entry.stage === stage) ?? { stage };
  const next = change({ ...current });
  return config.some(entry => entry.stage === stage)
    ? config.map(entry => (entry.stage === stage ? next : entry))
    : [...config, next];
}

/**
 * Runs `patch` through the PATCH validators and returns the validated body, or null when PATCH would reject it.
 * Must stay in step with what applyLoopConfigPatch (loopConfig.ts) validates for these fields.
 */
function validatedPatch(loop: ILoop, patch: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const out: Record<string, unknown> = {};
    if (patch.stages !== undefined) out.stages = validateLoopStages(patch.stages);
    const stages = (out.stages as string[] | undefined) ?? loop.stages;
    if (patch.stageConfig !== undefined) out.stageConfig = validateLoopStageConfig(patch.stageConfig, stages);
    if (patch.tools !== undefined) out.tools = validateLoopTools(patch.tools);
    if (patch.intervalMinutes !== undefined) out.intervalMinutes = validateLoopInterval(patch.intervalMinutes);
    if (patch.budgetCreditsPerDay !== undefined)
      out.budgetCreditsPerDay = validateLoopBudget(patch.budgetCreditsPerDay);
    return out;
  } catch {
    return null;
  }
}

/** Whether applying `patch` would leave the loop as it is (key order and unset-vs-empty aside). */
function isNoOp(loop: ILoop, patch: Record<string, unknown>): boolean {
  const norm = (value: unknown) => JSON.parse(JSON.stringify(value ?? null));
  return Object.entries(patch).every(([field, value]) => {
    if (field !== 'stageConfig') return isEqual(norm(loop[field as keyof ILoop]), norm(value));
    // Validation drops empty entries and the config of the last stage, so compare what each stage resolves to.
    const after = { stageConfig: (value as ILoopStageConfig[] | null) ?? [] };
    return loop.stages.every(stage => isEqual(norm(stageConfigOf(loop, stage)), norm(stageConfigOf(after, stage))));
  });
}

/** The window's runs and tickets folded per stage: ratings of the closed tickets that went through it, open tickets. */
function perStage(input: CoachInput) {
  const { loop, tickets, now } = input;
  const from = now.getTime() - COACH.windowDays * DAY_MS;
  const rated = new Map<string, { up: number; down: number }>();
  const open = new Map<string, number>();
  for (const ticket of tickets) {
    if (ticket.status !== 'closed') {
      if (ticket.stage) open.set(ticket.stage, (open.get(ticket.stage) ?? 0) + 1);
      continue;
    }
    const rating = ticket.ownerRating?.value;
    if (!rating || !ticket.closedAt || new Date(ticket.closedAt).getTime() < from) continue;
    for (const stage of new Set(ticketSegment(ticket, loop.stages).map(entry => entry.stage))) {
      const row = rated.get(stage) ?? { up: 0, down: 0 };
      row[rating]++;
      rated.set(stage, row);
    }
  }
  return {
    rated: (stage: string) => rated.get(stage) ?? { up: 0, down: 0 },
    open: (stage: string) => open.get(stage) ?? 0,
  };
}

/**
 * Rule-based suggestions to change a loop's stages, models, tools, schedule and budget, each with its numbers. Pure:
 * the coach route reads the inputs and applies a suggestion only when the owner asks. Drops a suggestion the owner
 * dismissed in the last `COACH.dismissDays`, one for the stage on trial, one that would change nothing, and one whose
 * patch PATCH would reject.
 */
export function coachSuggestions(input: CoachInput): LoopCoachSuggestion[] {
  const { loop, stats, now } = input;
  const out: LoopCoachSuggestion[] = [];
  const add = (suggestion: Omit<LoopCoachSuggestion, 'trialable'> & { trialable?: boolean }) =>
    out.push({ trialable: false, ...suggestion });
  const { rated, open } = perStage(input);
  const worked = loop.stages.slice(0, -1);
  const rowOf = (stage: string) => stats.byStage.find(row => row.stage === stage);

  // Budget and schedule.
  const budget = loop.budgetCreditsPerDay;
  const from = now.getTime() - COACH.windowDays * DAY_MS;
  const windowRuns = input.runs.filter(run => new Date(run.createdAt).getTime() >= from);
  if (budget) {
    const lastDays = stats.daily.slice(-COACH.raiseBudget.days);
    const stoppedDays = new Set(
      windowRuns
        .filter(run => run.loopOutcome === 'budget_stopped')
        .map(run => new Date(run.createdAt).toISOString().slice(0, 10))
    );
    const outDays = lastDays.filter(day => day.credits >= budget || stoppedDays.has(day.day)).length;
    if (outDays >= COACH.raiseBudget.minDays) {
      add({
        key: 'raise_budget',
        kind: 'budget',
        title: 'Raise the daily budget',
        evidence: `Budget ran out on ${outDays} of the last ${lastDays.length} days`,
        patch: { budgetCreditsPerDay: Math.ceil(budget * COACH.raiseBudget.factor) },
      });
    }
    const usedDays = stats.daily.filter(day => day.credits > 0);
    const peak = Math.max(0, ...usedDays.map(day => day.credits));
    if (usedDays.length >= COACH.lowerBudget.minDays && peak <= budget * COACH.lowerBudget.peakRate) {
      add({
        key: 'lower_budget',
        kind: 'budget',
        title: 'Lower the daily budget',
        evidence: `Peak day used ${Math.round(peak)} of ${budget} credits over ${usedDays.length} days with runs`,
        patch: { budgetCreditsPerDay: Math.ceil(peak * COACH.lowerBudget.factor) },
      });
    }
  }
  const idle = windowRuns.filter(run => run.loopOutcome === 'idle').length;
  if (
    loop.wakeMode !== 'tickets' &&
    windowRuns.length >= COACH.slowerSchedule.minRuns &&
    idle / windowRuns.length >= COACH.slowerSchedule.idleRate
  ) {
    add({
      key: 'slower_schedule',
      kind: 'schedule',
      title: 'Run less often',
      evidence: `${idle} of ${windowRuns.length} runs found no work`,
      patch: { intervalMinutes: Math.min(loop.intervalMinutes * 2, INTERVAL_MAX) },
    });
  }

  // Models.
  for (const stage of worked) {
    const row = rowOf(stage);
    if (!row) continue;
    const { up, down } = rated(stage);
    const current = stageConfigOf(loop, stage).model ?? loop.model;
    const currentInfo = input.models.find(model => model.id === current);
    const currentPrice = tokenPrice(currentInfo);
    if (
      up + down >= COACH.cheaperModel.minRated &&
      up / (up + down) >= COACH.cheaperModel.upRate &&
      row.runs > 0 &&
      row.outcomes.done / row.runs >= COACH.cheaperModel.doneRate &&
      currentInfo &&
      currentPrice
    ) {
      const cheaper = input.models
        .filter(
          model =>
            model.type === 'text' &&
            model.supportsTools &&
            model.backend === currentInfo.backend &&
            model.id !== current &&
            (tokenPrice(model) ?? Infinity) <= currentPrice * COACH.cheaperModel.maxPriceRatio
        )
        .sort((a, b) => tokenPrice(a)! - tokenPrice(b)!)[0];
      if (cheaper) {
        add({
          key: `cheaper_model:${stage}`,
          kind: 'model',
          stage,
          title: `Try a cheaper model for ${stage}`,
          evidence: `${stage}: ${up} of ${up + down} rated up; ${cheaper.id} costs ~${Math.round((1 - tokenPrice(cheaper)! / currentPrice) * 100)}% less per token than ${current}`,
          patch: { stageConfig: withStage(loop, stage, entry => ({ ...entry, model: cheaper.id })) },
          trialable: true,
        });
      }
    }
    const failed = row.outcomes.failed + row.outcomes.blocked;
    const downHeavy = up + down > 0 && down / (up + down) >= COACH.strongerModel.downRate;
    const failHeavy = row.runs > 0 && failed / row.runs >= COACH.strongerModel.failRate;
    if (row.runs >= COACH.strongerModel.minRuns && (downHeavy || failHeavy)) {
      const target = stageConfigOf(loop, stage).escalationModel ?? loop.escalationModel;
      const evidence = downHeavy
        ? `${stage}: ${down} of ${up + down} rated down`
        : `${stage}: ${failed} of ${row.runs} runs failed or blocked`;
      if (target && target !== current) {
        add({
          key: `stronger_model:${stage}`,
          kind: 'model',
          stage,
          title: `Use ${target} for ${stage}`,
          evidence,
          patch: { stageConfig: withStage(loop, stage, entry => ({ ...entry, model: target })) },
          trialable: true,
        });
      } else {
        add({
          key: `stronger_model:${stage}`,
          kind: 'model',
          stage,
          title: `Set an escalation model for ${stage}`,
          evidence,
        });
      }
    }
  }

  // Tools.
  for (const stage of worked) {
    const row = rowOf(stage);
    if (!row) continue;
    const stageTools = stageConfigOf(loop, stage).tools;
    const tools = stageTools ?? loop.tools;
    for (const { tool, count } of row.toolsUnavailable) {
      if (count < COACH.addTool.minRuns || tools.includes(tool) || !input.canAddTool(tool)) continue;
      add({
        key: `add_tool:${stage}:${tool}`,
        kind: 'tool',
        stage,
        title: `Give ${stage} the ${tool} tool`,
        evidence: `${tool} was asked for but unavailable in ${count} ${stage} runs`,
        patch: stageTools
          ? { stageConfig: withStage(loop, stage, entry => ({ ...entry, tools: [...stageTools, tool] })) }
          : { tools: [...loop.tools, tool] },
      });
    }
    if (row.runs < COACH.failingTool.minRuns) continue;
    for (const { tool, count } of row.toolsErrored) {
      if (count / row.runs < COACH.failingTool.rate) continue;
      add({
        key: `failing_tool:${stage}:${tool}`,
        kind: 'tool',
        stage,
        title: `Check the ${tool} tool`,
        evidence: `${tool} errored in ${count} of ${row.runs} ${stage} runs`,
      });
    }
  }

  // Stages.
  worked.forEach((stage, index) => {
    const row = rowOf(stage);
    if (!row) return;
    const next = rowOf(loop.stages[index + 1]);
    if (
      loop.stages.length > 2 &&
      row.runs >= COACH.removeStage.minRuns &&
      row.outcomes.done / row.runs >= COACH.removeStage.doneRate &&
      (next?.backMoves ?? 0) === 0
    ) {
      const waiting = open(stage);
      add({
        key: `remove_stage:${stage}`,
        kind: 'stage',
        stage,
        title: `Remove the ${stage} stage`,
        evidence: `${stage} passed ${row.outcomes.done} of ${row.runs} runs as done, and nothing came back to it`,
        patch: { stages: loop.stages.filter(name => name !== stage) },
        ...(waiting > 0 && { disabledReason: `Move its ${waiting} tickets first` }),
      });
    }
    if (row.runs >= COACH.addStage.minRuns && row.outcomes.unsure / row.runs >= COACH.addStage.unsureRate) {
      let name = 'refine';
      for (let n = 2; loop.stages.includes(name); n++) name = `refine-${n}`;
      const reasons = (input.unsureReasons[stage] ?? []).slice(0, COACH.addStage.reasons);
      add({
        key: `add_stage_before:${stage}`,
        kind: 'stage',
        stage,
        title: `Add a ${name} stage before ${stage}`,
        evidence:
          `${row.outcomes.unsure} of ${row.runs} ${stage} runs parked unsure (${pct(row.outcomes.unsure, row.runs)}).` +
          (reasons.length ? ` Top reasons: ${reasons.join('; ')}` : ''),
        patch: {
          stages: [...loop.stages.slice(0, index), name, ...loop.stages.slice(index)],
          stageConfig: [...(loop.stageConfig ?? []), { stage: name, instructions: COACH_REFINE_INSTRUCTIONS }],
        },
      });
    }
  });

  const dismissedSince = now.getTime() - COACH.dismissDays * DAY_MS;
  const dismissed = new Set(
    (loop.coachDismissed ?? []).filter(entry => new Date(entry.at).getTime() >= dismissedSince).map(entry => entry.key)
  );
  const kindOrder = (kind: string) => LOOP_COACH_KINDS.indexOf(kind as (typeof LOOP_COACH_KINDS)[number]);
  return out
    .flatMap(suggestion => {
      if (dismissed.has(suggestion.key)) return [];
      if (loop.coachTrial && suggestion.stage === loop.coachTrial.stage) return [];
      if (!suggestion.patch) return [suggestion];
      const patch = validatedPatch(loop, suggestion.patch);
      if (!patch || isNoOp(loop, patch)) return [];
      return [{ ...suggestion, patch }];
    })
    .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind))
    .slice(0, COACH.maxShown);
}

function side(model: string, runs: LoopStatsRun[], tickets: Map<string, IWorkItem>): LoopCoachTrialSide {
  const finished = runs.filter(run => run.loopOutcome);
  const worked = [...new Set(finished.flatMap(run => (run.workItemId ? [run.workItemId] : [])))];
  const ratings = worked.map(id => tickets.get(id)?.ownerRating?.value);
  const credits = runs.reduce((sum, run) => sum + (run.totalCreditsUsed ?? 0), 0);
  const durations = runs.flatMap(run =>
    run.completedAt ? [new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()] : []
  );
  return {
    model,
    runs: runs.length,
    tickets: worked.length,
    up: ratings.filter(value => value === 'up').length,
    down: ratings.filter(value => value === 'down').length,
    creditsPerRun: runs.length ? credits / runs.length : null,
    medianRunMs: median(durations),
    doneRate: finished.length ? finished.filter(run => run.loopOutcome === 'done').length / finished.length : null,
  };
}

/**
 * A trial's progress and its comparison with the stage's previous model: the trial side is the stage's runs on the
 * trial model since `startedAt`, the baseline its runs on `baselineModel` in the window before. A ticket counts once
 * a run on it finished. Complete at `trial.tickets`; nothing reverts by itself.
 */
export function trialComparison(trial: ILoopCoachTrial, runs: LoopStatsRun[], tickets: IWorkItem[]) {
  const start = new Date(trial.startedAt).getTime();
  const at = (run: LoopStatsRun) => new Date(run.createdAt).getTime();
  const onStage = runs.filter(run => run.loopStage === trial.stage);
  const byId = new Map(tickets.map(ticket => [ticket.id, ticket]));
  const trialSide = side(
    trial.model,
    onStage.filter(run => run.model === trial.model && at(run) >= start),
    byId
  );
  const baseline = side(
    trial.baselineModel,
    onStage.filter(
      run => run.model === trial.baselineModel && at(run) < start && at(run) >= start - COACH.windowDays * DAY_MS
    ),
    byId
  );
  return { done: trialSide.tickets, complete: trialSide.tickets >= trial.tickets, trial: trialSide, baseline };
}
