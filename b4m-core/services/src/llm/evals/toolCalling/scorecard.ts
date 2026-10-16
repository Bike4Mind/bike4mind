/**
 * Aggregates stored turns into the tool-calling scorecard: per-tool success rate and error classes,
 * calls per turn, repeated calls, latency, and how often an offered tool goes uncalled - overall and
 * split by `toolMode`. Pure; reading quests is the caller's job (packages/scripts/toolCallingScorecard.ts).
 */
import { unwrapToolErrorText, type ChatToolMode, type PromptMeta, type ToolErrorCategory } from '@bike4mind/common';
import { buildToolUsage } from '../../../telemetry/contextBreakdown';
import { categorizeToolError } from '../../../telemetry/TelemetryBuilder';

/** The slice of a stored turn the scorecard reads. */
export type ToolCallingTurn = Pick<PromptMeta, 'offeredTools' | 'functionCalls' | 'toolMode'>;

/**
 * Why a call did not succeed. `malformed_arguments` is the adapters' own rejection of the model's
 * arguments; `unrecorded` is a call whose outcome was never written (e.g. an unknown tool name the
 * adapter skipped), so it is neither a success nor a failure.
 */
export type ToolCallErrorClass = ToolErrorCategory | 'malformed_arguments' | 'unrecorded';

/** `rate` is count / total, or null when nothing was counted. */
export type ToolCallingRate = { count: number; total: number; rate: number | null };

/** Nearest-rank percentiles; null when there were no samples. */
export type ToolCallingDistribution = {
  samples: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
};

export type ToolScore = {
  name: string;
  /** Turns that offered this tool. */
  offeredTurns: number;
  /** Turns that called it at least once. */
  calledTurns: number;
  /** Share of the turns offering this tool that never called it. */
  offeredUncalled: ToolCallingRate;
  /** Calls to a tool the turn did not offer - a model hallucinating a name, or a recording gap. */
  callsNotOffered: number;
  invocations: number;
  /** Successes over calls with a recorded outcome; `unrecorded` calls are left out. */
  success: ToolCallingRate;
  errorClasses: Partial<Record<ToolCallErrorClass, number>>;
  /** Calls repeating an earlier successful call in the same turn with the same arguments. */
  repeatedCalls: number;
  /** Per-call wall time, ms. */
  latencyMs: ToolCallingDistribution;
};

export type ToolCallingScorecard = {
  turns: number;
  /** Turns that offered at least one tool. */
  turnsOffered: number;
  /** Calls per turn, over the turns that offered tools. */
  callsPerTurn: ToolCallingDistribution;
  /** Calls that were a repeat or did not succeed, over all calls. */
  wasted: ToolCallingRate;
  /** Sorted by invocations, then offered turns, then name. */
  tools: ToolScore[];
};

/** `unset` covers every turn whose request named no toolMode, which includes all in-app chat. */
export type ToolCallingSegment = ChatToolMode | 'unset';

export type ToolCallingReport = {
  generatedAt: string;
  overall: ToolCallingScorecard;
  byToolMode: Partial<Record<ToolCallingSegment, ToolCallingScorecard>>;
};

type FunctionCall = NonNullable<PromptMeta['functionCalls']>[number];

/** Must stay in sync with the observations the llm-adapters backends record on a rejected call. */
const MALFORMED_ARGUMENT_PREFIXES = [
  'Error: Tool arguments were malformed',
  'Error: Tool parameters were corrupted',
] as const;

export function classifyToolCallError(call: FunctionCall): ToolCallErrorClass | null {
  if (call.success === true) return null;
  if (call.success === undefined) return 'unrecorded';
  // `error` is never populated today; the adapters put the message in `returnValue`.
  const message = call.error ?? call.returnValue ?? '';
  if (MALFORMED_ARGUMENT_PREFIXES.some(prefix => message.startsWith(prefix))) return 'malformed_arguments';
  // Unwrapped first so a tool name such as `oauth_lookup` cannot steer the substring match.
  return categorizeToolError(unwrapToolErrorText(message));
}

/** Key-order-independent, so `{a, b}` and `{b, a}` count as the same arguments. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function rateOf(count: number, total: number): ToolCallingRate {
  return { count, total, rate: total === 0 ? null : count / total };
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function distributionOf(values: readonly number[]): ToolCallingDistribution {
  if (values.length === 0) return { samples: 0, mean: null, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

type ToolTally = {
  offeredTurns: number;
  calledTurns: number;
  offeredAndCalledTurns: number;
  callsNotOffered: number;
  invocations: number;
  successes: number;
  failures: number;
  errorClasses: Partial<Record<ToolCallErrorClass, number>>;
  repeatedCalls: number;
  latenciesMs: number[];
};

function emptyTally(): ToolTally {
  return {
    offeredTurns: 0,
    calledTurns: 0,
    offeredAndCalledTurns: 0,
    callsNotOffered: 0,
    invocations: 0,
    successes: 0,
    failures: 0,
    errorClasses: {},
    repeatedCalls: 0,
    latenciesMs: [],
  };
}

function toScore(name: string, tally: ToolTally): ToolScore {
  return {
    name,
    offeredTurns: tally.offeredTurns,
    calledTurns: tally.calledTurns,
    offeredUncalled: rateOf(tally.offeredTurns - tally.offeredAndCalledTurns, tally.offeredTurns),
    callsNotOffered: tally.callsNotOffered,
    invocations: tally.invocations,
    success: rateOf(tally.successes, tally.successes + tally.failures),
    errorClasses: tally.errorClasses,
    repeatedCalls: tally.repeatedCalls,
    latencyMs: distributionOf(tally.latenciesMs),
  };
}

/** Folds one turn's calls into the tallies; returns how many of them were wasted. */
function tallyCalls(calls: readonly FunctionCall[], tallyFor: (name: string) => ToolTally): number {
  const seen = new Set<string>();
  let wasted = 0;
  for (const call of calls) {
    if (!call.name) continue;
    const tally = tallyFor(call.name);
    const errorClass = classifyToolCallError(call);
    // Only a success seeds a key: re-issuing a call that failed or went unrecorded is a retry, not a
    // repeat, and is already counted as wasted through its own error class. Malformed calls never repeat.
    const key = `${call.name}\u0000${canonicalJson(call.parameters ?? {})}`;
    const malformed = errorClass === 'malformed_arguments';
    const repeated = !malformed && seen.has(key);
    if (call.success === true) seen.add(key);
    if (repeated) tally.repeatedCalls += 1;

    if (errorClass) tally.errorClasses[errorClass] = (tally.errorClasses[errorClass] ?? 0) + 1;
    if (typeof call.executionTime === 'number') tally.latenciesMs.push(call.executionTime);
    if (repeated || errorClass) wasted += 1;
  }
  return wasted;
}

export function buildToolCallingScorecard(turns: readonly ToolCallingTurn[]): ToolCallingScorecard {
  const tallies = new Map<string, ToolTally>();
  const tallyFor = (name: string): ToolTally => {
    const existing = tallies.get(name);
    if (existing) return existing;
    const created = emptyTally();
    tallies.set(name, created);
    return created;
  };

  const callsPerOfferedTurn: number[] = [];
  let totalCalls = 0;
  let wastedCalls = 0;

  for (const turn of turns) {
    let turnCalls = 0;
    for (const usage of buildToolUsage(turn)) {
      const tally = tallyFor(usage.name);
      tally.invocations += usage.invocations;
      tally.successes += usage.successes;
      tally.failures += usage.failures;
      turnCalls += usage.invocations;
      if (usage.offered) tally.offeredTurns += 1;
      if (usage.invocations > 0) tally.calledTurns += 1;
      if (usage.offered && usage.invocations > 0) tally.offeredAndCalledTurns += 1;
      if (!usage.offered) tally.callsNotOffered += usage.invocations;
    }
    wastedCalls += tallyCalls(turn.functionCalls ?? [], tallyFor);
    totalCalls += turnCalls;
    if ((turn.offeredTools?.length ?? 0) > 0) callsPerOfferedTurn.push(turnCalls);
  }

  const tools = [...tallies.entries()]
    .map(([name, tally]) => toScore(name, tally))
    .sort(
      (a, b) =>
        b.invocations - a.invocations ||
        b.offeredTurns - a.offeredTurns ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );

  return {
    turns: turns.length,
    turnsOffered: callsPerOfferedTurn.length,
    callsPerTurn: distributionOf(callsPerOfferedTurn),
    wasted: rateOf(wastedCalls, totalCalls),
    tools,
  };
}

export function buildToolCallingReport(turns: readonly ToolCallingTurn[], now = new Date()): ToolCallingReport {
  const bySegment = new Map<ToolCallingSegment, ToolCallingTurn[]>();
  for (const turn of turns) {
    const segment: ToolCallingSegment = turn.toolMode ?? 'unset';
    const segmentTurns = bySegment.get(segment);
    if (segmentTurns) segmentTurns.push(turn);
    else bySegment.set(segment, [turn]);
  }
  return {
    generatedAt: now.toISOString(),
    overall: buildToolCallingScorecard(turns),
    byToolMode: Object.fromEntries(
      [...bySegment.entries()].map(([segment, segmentTurns]) => [segment, buildToolCallingScorecard(segmentTurns)])
    ),
  };
}
