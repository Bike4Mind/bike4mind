import {
  REPLY_STATS_SIGNIFICANT_WAIT_MS,
  type ChatReplyStats,
  type ChatReplyStatsEstimate,
  type ChatRoundTiming,
  type ChatUsage,
} from '@shared/chat';
import { MIN_ESTIMATE_SPAN_MS } from './tokenRate';

/** What one request adds to its reply's stats; ChatService's raw rounds fit this shape. */
export interface StatsRound {
  timing: ChatRoundTiming;
  reasoningFrames: number;
  /** Readable thinking, including blocks that only became readable once the round stopped. */
  reasoning?: string;
  usage?: ChatUsage;
}

export interface ReplyStatsInput {
  endedAt: number;
  /** This run's requests, in order; the first one's start is the run's. */
  rounds: readonly StatsRound[];
  toolMs: number;
  /** The whole reply's usage, a continued reply's earlier runs included. */
  usage?: ChatUsage;
  /** A self-hosted model streams about one token per frame, so its frames can stand in for a count. */
  local: boolean;
  /** A continued reply's stats from the runs before this one. */
  earlier?: ChatReplyStats;
}

const nonNegative = (ms: number) => Math.max(0, ms);

/**
 * A request's time before its server started on it: the load the server reported, or where it
 * reports none, the wall time outside its prompt and generation timings (derived: load, queue or connection).
 */
export function roundLoad(round: StatsRound): { ms: number; derived: boolean } | null {
  const rate = round.usage?.rate;
  if (!rate || rate.estimated || !Number.isFinite(rate.evalMs) || rate.evalMs <= 0) return null;
  if (rate.loadMs !== undefined && Number.isFinite(rate.loadMs))
    return { ms: nonNegative(rate.loadMs), derived: false };
  if (rate.loadReported !== false) return null;
  const promptMs = rate.promptMs !== undefined && Number.isFinite(rate.promptMs) ? rate.promptMs : 0;
  const outside = round.timing.endedAt - round.timing.startedAt - promptMs - rate.evalMs;
  return Number.isFinite(outside) && outside > 0 ? { ms: outside, derived: true } : null;
}

/**
 * A request's load or wait where it is long enough to name. Per request, not per reply: a short
 * wait on every request (a handshake, a reconnect) is overhead however many requests add up.
 */
function countedLoad(round: StatsRound): { ms: number; derived: boolean } | null {
  const load = roundLoad(round);
  return load && load.ms >= REPLY_STATS_SIGNIFICANT_WAIT_MS ? load : null;
}

/**
 * The counted load of a continued reply's earlier runs; partial where they were stored without it
 * (no outputMs either) and the reply's usage cannot tell it per request, as countedLoad does.
 */
function earlierLoad({ earlier, usage, rounds }: ReplyStatsInput): { ms: number; partial: boolean } {
  const known = (ms: number) => ({ ms, partial: false });
  if (!earlier) return known(0);
  if (earlier.loadMs !== undefined || earlier.outputMs !== undefined || !(earlier.modelMs > 0))
    return { ms: earlier.loadMs ?? 0, partial: earlier.loadPartial === true };
  const rate = usage?.rate;
  if (!rate || rate.estimated) return known(0);
  const reported = rate.loadMs;
  if (reported !== undefined && Number.isFinite(reported)) {
    const ours = rounds.reduce((sum, round) => sum + (round.usage?.rate?.loadMs ?? 0), 0);
    const theirs = reported - ours;
    if (!Number.isFinite(theirs) || theirs < REPLY_STATS_SIGNIFICANT_WAIT_MS) return known(0);
    // Only a run that ran no tools was a single request, whose load the sum then is.
    return earlier.toolMs === 0 ? known(theirs) : { ms: 0, partial: true };
  }
  return rate.loadReported === true ? known(0) : { ms: 0, partial: true };
}

/** The server's own time before generating: load and prompt processing; 0 where it reported neither. */
function serverLeadMs(round: StatsRound): number {
  const promptMs = round.usage?.rate?.estimated ? undefined : round.usage?.rate?.promptMs;
  return (roundLoad(round)?.ms ?? 0) + (promptMs !== undefined && Number.isFinite(promptMs) ? promptMs : 0);
}

/**
 * One round's thinking: the span its thinking frames cover. With no span to measure (thinking the
 * provider sent nothing for, or one frame), the wait before its first output, less any load and
 * prompt time its server reported, as an estimate. A self-hosted round with a readable frame keeps
 * its frame span, however short: the wait is model load.
 */
export function roundThinking(round: StatsRound, local = false): { ms: number; derived: boolean } | null {
  const { startedAt, firstTokenAt, firstReasoningAt, lastReasoningAt, firstTextAt } = round.timing;
  if (
    firstReasoningAt !== undefined &&
    lastReasoningAt !== undefined &&
    (lastReasoningAt > firstReasoningAt || (local && round.reasoningFrames > 0))
  ) {
    return { ms: lastReasoningAt - firstReasoningAt, derived: false };
  }
  const thought =
    firstReasoningAt !== undefined || !!round.reasoning?.trim() || (round.usage?.reasoningTokens ?? 0) > 0;
  const shown = firstTextAt ?? lastReasoningAt ?? firstTokenAt;
  if (!thought || shown === undefined) return null;
  return { ms: nonNegative(shown - startedAt - serverLeadMs(round)), derived: true };
}

/**
 * The tokens one request generated and the time it spent on them, timed from its first output or,
 * when it thought without streaming the thinking, from the request. Null where a server timed the
 * request itself, or where the span is too short to tell from latency: a tool call that arrives
 * whole, say, carries all its tokens in no time at all.
 */
export function roundGeneration(round: StatsRound): { tokens: number; ms: number; untimedTokens: number } | null {
  const output = round.usage?.outputTokens;
  const { startedAt, firstTokenAt, endedAt } = round.timing;
  if (round.usage?.rate || output === undefined || firstTokenAt === undefined) return null;
  const hidden = roundThinking(round)?.derived === true;
  // From the first output, that token's own time is the prompt's. estimatedRate drops the whole
  // first read; a round records no read sizes, so this drops one token.
  const untimedTokens = hidden ? 0 : 1;
  const tokens = output - untimedTokens;
  const ms = endedAt - (hidden ? startedAt : firstTokenAt);
  return tokens > 0 && ms >= MIN_ESTIMATE_SPAN_MS ? { tokens, ms, untimedTokens } : null;
}

/** A lone output token of a round roundGeneration cannot time: its time is the prompt's, so it is untimed by design. */
function lonelyToken(round: StatsRound): number {
  const { rate, outputTokens } = round.usage ?? {};
  if (rate || outputTokens !== 1 || round.timing.firstTokenAt === undefined) return 0;
  return roundThinking(round)?.derived === true ? 0 : 1;
}

/** The reply's stats from its rounds, folded onto a continued reply's earlier runs. */
export function buildReplyStats(input: ReplyStatsInput): ChatReplyStats {
  const { earlier, rounds } = input;
  // Re-decided below, so a server count arriving on a continued reply clears an earlier estimate.
  const derived = new Set<ChatReplyStatsEstimate>(earlier?.derived?.filter(estimate => estimate !== 'reasoningTokens'));
  let modelMs = earlier?.modelMs ?? 0;
  let reasoningMs = earlier?.reasoningMs;
  let firstTokenMs = earlier?.firstTokenMs;
  let generation = earlier?.generation;
  const before = earlierLoad(input);
  let loadMs = before.ms;
  let firstTokenLoadMs = earlier?.firstTokenMs !== undefined ? earlier.firstTokenLoadMs : undefined;
  // Unknown for good when an earlier run that reached the model was stored before outputMs was kept.
  let outputMs: number | null = earlier ? (earlier.outputMs ?? (earlier.modelMs > 0 ? null : 0)) : 0;
  let lonelyTokens = 0;
  // An earlier run's estimate stands in for the frames it was counted from.
  let reasoningFrames = earlier?.derived?.includes('reasoningTokens') ? (earlier.reasoningTokens ?? 0) : 0;

  for (const round of rounds) {
    const { timing } = round;
    modelMs += nonNegative(timing.endedAt - timing.startedAt);
    const load = countedLoad(round);
    if (load) {
      loadMs += load.ms;
      if (load.derived) derived.add('loadMs');
    }
    if (timing.firstTokenAt !== undefined) {
      if (firstTokenMs === undefined) {
        firstTokenMs = nonNegative(timing.firstTokenAt - timing.startedAt);
        if (load) firstTokenLoadMs = load.ms;
      }
      if (outputMs !== null) outputMs += nonNegative(timing.endedAt - timing.firstTokenAt);
    }
    reasoningFrames += round.reasoningFrames;
    const thinking = roundThinking(round, input.local);
    if (thinking) {
      reasoningMs = (reasoningMs ?? 0) + thinking.ms;
      if (thinking.derived) derived.add('reasoningMs');
    }
    // A self-hosted round is rated by its server, or by estimatedRate where its read guard trusts the stream.
    const generated = input.local ? null : roundGeneration(round);
    if (generated) {
      generation = {
        tokens: (generation?.tokens ?? 0) + generated.tokens,
        ms: (generation?.ms ?? 0) + generated.ms,
        untimedTokens: (generation?.untimedTokens ?? 0) + generated.untimedTokens,
      };
    } else if (!input.local) {
      lonelyTokens += lonelyToken(round);
    }
  }
  if (generation && lonelyTokens > 0) {
    generation = { ...generation, untimedTokens: (generation.untimedTokens ?? 0) + lonelyTokens };
  }

  let reasoningTokens = input.usage?.reasoningTokens;
  if (reasoningTokens === undefined && input.local && reasoningFrames > 0) {
    const output = input.usage?.outputTokens;
    reasoningTokens = output === undefined ? reasoningFrames : Math.min(reasoningFrames, output);
    derived.add('reasoningTokens');
  }

  // From this run's first request: the turn's setup before it (servers, catalog, memory) is not the reply's.
  const startedAt = rounds[0]?.timing.startedAt ?? input.endedAt;
  return {
    totalMs: (earlier?.totalMs ?? 0) + nonNegative(input.endedAt - startedAt),
    modelMs,
    toolMs: (earlier?.toolMs ?? 0) + input.toolMs,
    // Kept at 0 without outputMs too: the renderer reads a reply with neither as stored before loads.
    ...(loadMs > 0 || outputMs === null ? { loadMs } : {}),
    ...(before.partial ? { loadPartial: true as const } : {}),
    ...(outputMs !== null && modelMs > 0 ? { outputMs } : {}),
    ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
    ...(firstTokenLoadMs !== undefined ? { firstTokenLoadMs } : {}),
    ...(reasoningMs !== undefined ? { reasoningMs } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(generation ? { generation } : {}),
    ...(derived.size > 0 ? { derived: [...derived].sort() } : {}),
  };
}
