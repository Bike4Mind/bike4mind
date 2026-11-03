import type { ChatReplyStats, ChatReplyStatsEstimate, ChatRoundTiming, ChatUsage } from '@shared/chat';
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
 * One round's thinking: the span its thinking frames cover. With no span to measure (thinking the
 * provider sent nothing for, or one frame), the wait before its first output, as an estimate.
 */
export function roundThinking(round: StatsRound): { ms: number; derived: boolean } | null {
  const { startedAt, firstTokenAt, firstReasoningAt, lastReasoningAt, firstTextAt } = round.timing;
  if (firstReasoningAt !== undefined && lastReasoningAt !== undefined && lastReasoningAt > firstReasoningAt) {
    return { ms: lastReasoningAt - firstReasoningAt, derived: false };
  }
  const thought =
    firstReasoningAt !== undefined || !!round.reasoning?.trim() || (round.usage?.reasoningTokens ?? 0) > 0;
  const shown = firstTextAt ?? lastReasoningAt ?? firstTokenAt;
  if (!thought || shown === undefined) return null;
  return { ms: nonNegative(shown - startedAt), derived: true };
}

/**
 * The tokens one request generated and the time it spent on them, timed from its first output or,
 * when it thought without streaming the thinking, from the request. Null where a server timed the
 * request itself, or where the span is too short to tell from latency: a tool call that arrives
 * whole, say, carries all its tokens in no time at all.
 */
export function roundGeneration(round: StatsRound): { tokens: number; ms: number } | null {
  const output = round.usage?.outputTokens;
  const { startedAt, firstTokenAt, endedAt } = round.timing;
  if (round.usage?.rate || output === undefined || firstTokenAt === undefined) return null;
  const hidden = roundThinking(round)?.derived === true;
  // From the first output, that token's own time is the prompt's, as in estimatedRate.
  const tokens = hidden ? output : output - 1;
  const ms = endedAt - (hidden ? startedAt : firstTokenAt);
  return tokens > 0 && ms >= MIN_ESTIMATE_SPAN_MS ? { tokens, ms } : null;
}

/** The reply's stats from its rounds, folded onto a continued reply's earlier runs. */
export function buildReplyStats(input: ReplyStatsInput): ChatReplyStats {
  const { earlier, rounds } = input;
  // Re-decided below, so a server count arriving on a continued reply clears an earlier estimate.
  const derived = new Set<ChatReplyStatsEstimate>(earlier?.derived?.filter(estimate => estimate !== 'reasoningTokens'));
  let modelMs = earlier?.modelMs ?? 0;
  let reasoningMs = earlier?.reasoningMs;
  let firstTokenMs = earlier?.firstTokenMs;
  // Stats stored before firstTokenMs was kept have an epoch firstTokenAt, timed from the turn's
  // setup; this run's first token is not the reply's, so the reply has none.
  const firstTokenUnknown = earlier !== undefined && 'firstTokenAt' in earlier;
  let generation = earlier?.generation;
  // An earlier run's estimate stands in for the frames it was counted from.
  let reasoningFrames = earlier?.derived?.includes('reasoningTokens') ? (earlier.reasoningTokens ?? 0) : 0;

  for (const round of rounds) {
    const { timing } = round;
    modelMs += nonNegative(timing.endedAt - timing.startedAt);
    if (timing.firstTokenAt !== undefined && !firstTokenUnknown) {
      firstTokenMs ??= nonNegative(timing.firstTokenAt - timing.startedAt);
    }
    reasoningFrames += round.reasoningFrames;
    const thinking = roundThinking(round);
    if (thinking) {
      reasoningMs = (reasoningMs ?? 0) + thinking.ms;
      if (thinking.derived) derived.add('reasoningMs');
    }
    // A self-hosted round is rated by its server, or by estimatedRate where its read guard trusts the stream.
    const generated = input.local ? null : roundGeneration(round);
    if (generated) {
      generation = { tokens: (generation?.tokens ?? 0) + generated.tokens, ms: (generation?.ms ?? 0) + generated.ms };
    }
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
    ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
    ...(reasoningMs !== undefined ? { reasoningMs } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(generation ? { generation } : {}),
    ...(derived.size > 0 ? { derived: [...derived].sort() } : {}),
  };
}
