import type { ChatMessage, ChatReplyStats, ChatUsage, ModelPhase } from '@shared/chat';
import { formatElapsed, formatTokens, type TurnProgress } from './statusLine';
import { formatTokenRate } from './tokenRate';

/** Every stat a reply can show, in the order the rail, the footer and Settings list them. */
export const REPLY_STATS = [
  'thinking',
  'total',
  'thinkingShare',
  'thinkingTokens',
  'tokens',
  'speed',
  'cacheShare',
  'promptSpeed',
  'firstToken',
  'load',
  'draft',
] as const;

export type ReplyStatId = (typeof REPLY_STATS)[number];

export function isReplyStatId(value: unknown): value is ReplyStatId {
  return typeof value === 'string' && (REPLY_STATS as readonly string[]).includes(value);
}

interface ReplyStatText {
  /** The rail's row label. */
  label: string;
  /** The Settings checklist's name for it. */
  setting: string;
  /** The value named inline, for the one-line footer. */
  inline: (value: string) => string;
}

export const REPLY_STAT_TEXT: Record<ReplyStatId, ReplyStatText> = {
  thinking: { label: 'Thinking time', setting: 'Thinking time', inline: value => `${value} thinking` },
  total: {
    label: 'Total time',
    setting: 'Total time, tools and approvals included',
    inline: value => `${value} total`,
  },
  thinkingShare: {
    label: 'Thinking share',
    setting: "Share of the model's time spent thinking",
    inline: value => `${value} of model time thinking`,
  },
  thinkingTokens: { label: 'Thinking tokens', setting: 'Thinking tokens', inline: value => `${value} thinking tokens` },
  tokens: {
    label: 'Total tokens',
    setting: 'Total tokens generated, thinking included',
    inline: value => `${value} tokens`,
  },
  speed: { label: 'Speed', setting: 'Tokens per second', inline: value => value },
  cacheShare: {
    label: 'Cache read',
    setting: 'Share of the prompt read from cache',
    inline: value => `${value} cached`,
  },
  promptSpeed: { label: 'Prompt speed', setting: 'Prompt processing speed', inline: value => `${value} prompt` },
  firstToken: { label: 'First token', setting: 'Time to first token', inline: value => `${value} to first token` },
  load: { label: 'Load time', setting: 'Model load time', inline: value => `${value} load` },
  draft: {
    label: 'Draft accepted',
    setting: 'Share of draft tokens accepted',
    inline: value => `${value} of draft tokens accepted`,
  },
};

/** One stat ready to draw. */
export interface ReplyStat {
  id: ReplyStatId;
  /** Formatted, with a leading ~ on an estimate. */
  value: string;
  /** What the estimate rests on; absent on a measured or reported value. */
  estimate?: string;
  /** What else the figure takes in, where its label alone would not say. */
  note?: string;
}

/** The two halves of a message a reply's stats are read from. */
export interface ReplyStatsSource {
  stats?: ChatReplyStats | undefined;
  usage?: ChatUsage | null | undefined;
}

const ESTIMATES = {
  thinking: 'estimated from the wait before the first output',
  thinkingTokens: 'estimated from the thinking frames the server streamed',
  speed: 'timed by this app from the stream',
} as const;

/** "820ms", "12.3s", "3m 7s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(Math.max(0, ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatElapsed(ms);
}

/** "30%", or "<1%" where rounding would say a share that is there is not. */
export function formatShare(share: number): string {
  const percent = Math.round(share * 100);
  return percent === 0 && share > 0 ? '<1%' : `${percent}%`;
}

/**
 * Thinking over the time spent waiting on the model, 0 to 1, so tools and approvals do not dilute
 * it; null when the reply did not think or the model took no time.
 */
export function thinkingShare(stats: ChatReplyStats | undefined): number | null {
  if (!stats || stats.reasoningMs === undefined || stats.modelMs <= 0) return null;
  return Math.min(1, Math.max(0, stats.reasoningMs / stats.modelMs));
}

/**
 * Tokens over generation time. A server's own timings where it sent them; otherwise what main
 * timed per request from the stream, which counts the network too and so is an estimate.
 */
export function generationRate({
  stats,
  usage,
}: ReplyStatsSource): { tokens: number; ms: number; estimated: boolean } | null {
  const rate = usage?.rate;
  if (rate && rate.evalTokens > 0 && rate.evalMs > 0) {
    return { tokens: rate.evalTokens, ms: rate.evalMs, estimated: rate.estimated === true };
  }
  const timed = stats?.generation;
  if (!timed || timed.tokens <= 0 || timed.ms <= 0) return null;
  return { tokens: timed.tokens, ms: timed.ms, estimated: true };
}

/**
 * Prompt tokens served from cache, over the whole prompt. A self-hosted server reports cached
 * apart from evaluated tokens, or (vLLM) inside its prompt count; a hosted one reports cache
 * reads apart from new input and cache writes.
 */
export function cacheReadShare(usage: ChatUsage | null | undefined): number | null {
  if (!usage) return null;
  const cached = usage.rate?.cachedPromptTokens;
  if (cached !== undefined) {
    const evaluated = usage.rate?.promptTokens;
    const whole = evaluated !== undefined ? cached + evaluated : usage.inputTokens;
    return whole !== undefined && whole > 0 ? Math.min(1, cached / whole) : null;
  }
  const read = usage.cacheReadInputTokens;
  if (read === undefined) return null;
  const whole = (usage.inputTokens ?? 0) + read + (usage.cacheCreationInputTokens ?? 0);
  return whole > 0 ? read / whole : null;
}

function stat(id: ReplyStatId, value: string | null, estimate?: string | false, note?: string): ReplyStat | null {
  if (value === null) return null;
  return {
    id,
    value: estimate ? `~${value}` : value,
    ...(estimate ? { estimate } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * Every stat the source has a value for, in REPLY_STATS order. `live` formats durations in whole
 * seconds, to tick with the status line's clock, and leaves out the total and the speed, which
 * that line shows while the turn runs, and the share, whose model time is not known until the end.
 */
export function replyStats(source: ReplyStatsSource, { live = false }: { live?: boolean } = {}): ReplyStat[] {
  const { stats, usage } = source;
  const derived = new Set<string>(stats?.derived ?? []);
  const duration = live ? formatElapsed : formatDuration;
  const thinkingEstimate = derived.has('reasoningMs') && ESTIMATES.thinking;
  const share = live ? null : thinkingShare(stats);
  const generation = live ? null : generationRate(source);
  const cached = cacheReadShare(usage);
  const rate = usage?.rate;
  const reasoningTokens = stats?.reasoningTokens ?? usage?.reasoningTokens;

  const all: Record<ReplyStatId, ReplyStat | null> = {
    thinking: stat('thinking', stats?.reasoningMs !== undefined ? duration(stats.reasoningMs) : null, thinkingEstimate),
    total: stat(
      'total',
      stats && !live ? duration(stats.totalMs) : null,
      false,
      stats && stats.toolMs > 0
        ? `includes ${formatDuration(stats.toolMs)} running tools and waiting for approval`
        : undefined
    ),
    thinkingShare: stat('thinkingShare', share !== null ? formatShare(share) : null, thinkingEstimate),
    thinkingTokens: stat(
      'thinkingTokens',
      reasoningTokens !== undefined ? formatTokens(reasoningTokens) : null,
      derived.has('reasoningTokens') && ESTIMATES.thinkingTokens
    ),
    tokens: stat('tokens', usage?.outputTokens !== undefined ? formatTokens(usage.outputTokens) : null),
    speed: stat(
      'speed',
      generation && formatTokenRate({ evalTokens: generation.tokens, evalMs: generation.ms }),
      generation?.estimated && ESTIMATES.speed
    ),
    cacheShare: stat('cacheShare', cached !== null ? formatShare(cached) : null),
    promptSpeed: stat(
      'promptSpeed',
      rate?.promptTokens !== undefined && rate.promptMs !== undefined
        ? formatTokenRate({ evalTokens: rate.promptTokens, evalMs: rate.promptMs })
        : null
    ),
    firstToken: stat('firstToken', stats?.firstTokenMs !== undefined ? formatDuration(stats.firstTokenMs) : null),
    load: stat('load', rate?.loadMs !== undefined ? formatDuration(rate.loadMs) : null),
    draft: stat(
      'draft',
      rate?.draftTokens && rate.draftAccepted !== undefined
        ? formatShare(Math.min(1, rate.draftAccepted / rate.draftTokens))
        : null,
      false,
      rate?.draftTokens ? `${rate.draftAccepted} of ${rate.draftTokens} draft tokens` : undefined
    ),
  };
  return REPLY_STATS.map(id => all[id]).filter((row): row is ReplyStat => row !== null);
}

/** A settled reply's stats; see replyStats. */
export function messageStats(message: ChatMessage): ReplyStat[] {
  return replyStats({ stats: message.stats, usage: message.usage });
}

/** A stat's estimate and note, for a title or a screen reader; null with neither. */
export function statDetail(row: ReplyStat): string | null {
  const parts = [row.estimate, row.note].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join('; ') : null;
}

/** One line per stat, label first, with what each estimate rests on; for a native title. */
export function describeReplyStats(rows: readonly ReplyStat[]): string | null {
  if (rows.length === 0) return null;
  return rows
    .map(row => {
      const detail = statDetail(row);
      return `${REPLY_STAT_TEXT[row.id].label}: ${row.value}${detail ? ` (${detail})` : ''}`;
    })
    .join('\n');
}

/**
 * What a reply in flight has measured so far, in the shape a settled one stores, on top of
 * `earlier`: a continued reply's stats from the runs before this one. Only the thinking time and
 * the first token are live; the rest is zero and left out of the live rail.
 */
export function liveReplyStats(turn: TurnProgress, now: number, earlier?: ChatReplyStats): ChatReplyStats {
  const open = turn.thinkingSince !== undefined ? Math.max(0, now - turn.thinkingSince) : 0;
  const thought = turn.thinkingMs !== undefined || turn.thinkingSince !== undefined;
  const reasoningMs = thought ? (earlier?.reasoningMs ?? 0) + (turn.thinkingMs ?? 0) + open : earlier?.reasoningMs;
  const firstTokenMs =
    earlier?.firstTokenMs ??
    (turn.firstTokenAt !== undefined ? Math.max(0, turn.firstTokenAt - (turn.requestAt ?? turn.startedAt)) : undefined);
  return {
    totalMs: 0,
    modelMs: 0,
    toolMs: 0,
    ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
    ...(reasoningMs !== undefined ? { reasoningMs } : {}),
    ...(earlier?.reasoningTokens !== undefined ? { reasoningTokens: earlier.reasoningTokens } : {}),
    ...(earlier?.derived ? { derived: earlier.derived } : {}),
  };
}

/**
 * The turn with a phase change folded into its thinking clock and its request and first-token
 * stamps. Returns the same object when nothing changed, so a repeated phase re-renders nothing.
 */
export function withPhase(turn: TurnProgress, phase: ModelPhase, now: number): TurnProgress {
  let next = turn;
  // Main sends a wait as each request goes out, so the first one is when the model was asked.
  if (phase.kind === 'waiting' && next.requestAt === undefined && next.firstTokenAt === undefined) {
    next = { ...next, requestAt: now };
  }
  if (phase.kind !== 'waiting' && next.firstTokenAt === undefined) next = { ...next, firstTokenAt: now };
  const thinking = phase.kind === 'thinking';
  if (thinking && next.thinkingSince === undefined) return { ...next, thinkingSince: now };
  if (!thinking && next.thinkingSince !== undefined) {
    const { thinkingSince, ...rest } = next;
    return { ...rest, thinkingMs: (next.thinkingMs ?? 0) + Math.max(0, now - thinkingSince) };
  }
  return next;
}
