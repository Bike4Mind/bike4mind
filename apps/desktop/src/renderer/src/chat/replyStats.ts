import {
  REPLY_STATS_SIGNIFICANT_WAIT_MS,
  type ChatMessage,
  type ChatReplyStats,
  type ChatUsage,
  type ModelPhase,
} from '@shared/chat';
import { readReplyStats } from '@shared/replyStats';
import { formatElapsed, formatTokens, type TurnProgress } from './statusLine';
import { formatTokenRate, untimedOutputNote } from './tokenRate';

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
}

export const REPLY_STAT_TEXT: Record<ReplyStatId, ReplyStatText> = {
  thinking: { label: 'Thinking time', setting: 'Thinking time' },
  total: {
    label: 'Total time',
    setting: 'Total time, tools and approvals included, a model load the server reported left out',
  },
  thinkingShare: {
    label: 'Thinking share',
    setting: 'Share spent thinking: of the output tokens where they were counted, else of the generation time',
  },
  thinkingTokens: { label: 'Thinking tokens', setting: 'Thinking tokens' },
  tokens: { label: 'Total tokens', setting: 'Total tokens generated, thinking and sub-agents included' },
  speed: { label: 'Speed', setting: 'Tokens per second, sub-agents left out' },
  cacheShare: { label: 'Cache read', setting: 'Share of the prompt read from cache' },
  promptSpeed: { label: 'Prompt speed', setting: 'Prompt processing speed' },
  firstToken: { label: 'First token', setting: 'Time to first token' },
  load: {
    label: 'Model load',
    setting: "Model load, or a self-hosted server's wait before it started, when long enough to matter",
  },
  draft: { label: 'Draft accepted', setting: 'Share of draft tokens accepted' },
};

/** A load the server reported, or a wait worked out from its timings, which can be any of these. */
const LOAD_KINDS = {
  load: { label: 'Model load', note: undefined },
  wait: { label: 'Server wait', note: 'load, queue or connection' },
} as const;

/**
 * The few stats the hover footer names, in its order and words; the rest are in its title. Each
 * names its unit or its kind, so no two figures on the line can be read as the same thing.
 */
export const FOOTER_STATS: readonly (readonly [ReplyStatId, (value: string, label: string) => string])[] = [
  ['speed', value => value],
  ['total', value => `${value} total`],
  // A server wait is part of the total, a reported load is not; see replyStats.
  ['load', (value, label) => `${value} ${label.toLowerCase()}${label === LOAD_KINDS.wait.label ? ' included' : ''}`],
  ['thinking', value => `${value} thinking`],
];

/** The footer's join before a stat: a reported load reads as added to the total it follows. */
export function footerSeparator(previous: ReplyStatId | undefined, id: ReplyStatId, label: string): string {
  return previous === 'total' && id === 'load' && label === LOAD_KINDS.load.label ? ' + ' : ' \xb7 ';
}

/** One stat ready to draw. */
export interface ReplyStat {
  id: ReplyStatId;
  /** In place of REPLY_STAT_TEXT's label, where the figure's basis changes from reply to reply. */
  label?: string;
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

/** Stored stats are read raw, so each entry point below takes them through readReplyStats. */
const readSource = ({ stats, usage }: ReplyStatsSource): ReplyStatsSource => ({ stats: readReplyStats(stats), usage });

const ESTIMATES = {
  thinking: 'estimated from the wait before the first output',
  thinkingTokens: 'estimated from the thinking frames the server streamed',
  speed: 'timed by this app from the stream',
} as const;

/** "820ms", "12.3s", "3m 7s"; rounded before the unit is picked, so 999.6ms reads "1.0s", not "1000ms". */
export function formatDuration(ms: number): string {
  // Callers drop a missing or non-finite duration; this only keeps one from printing "NaNms".
  const clamped = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (Math.round(clamped) < 1000) return `${Math.round(clamped)}ms`;
  const tenths = Math.round(clamped / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  return formatElapsed(Math.round(clamped / 1000) * 1000);
}

/** "30%", or "<1%" where rounding would say a share that is there is not. */
export function formatShare(share: number): string {
  const percent = Math.round(share * 100);
  return percent === 0 && share > 0 ? '<1%' : `${percent}%`;
}

const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);

/**
 * Thinking over output tokens where counted, else thinking over generation time (no tools, load or
 * prompt); null with no thinking, or a thinking time estimated from the wait, which holds the prompt.
 */
export function thinkingShare(
  source: ReplyStatsSource
): { share: number; basis: 'tokens' | 'time'; estimated: boolean } | null {
  const { stats, usage } = readSource(source);
  const counted = usage?.reasoningTokens;
  const reasoningTokens = counted ?? stats?.reasoningTokens;
  const outputTokens = usage?.outputTokens;
  const thought = (finite(reasoningTokens) && reasoningTokens > 0) || stats?.reasoningMs !== undefined;
  if (!thought) return null;
  if (finite(reasoningTokens) && finite(outputTokens) && outputTokens > 0) {
    const estimated = counted === undefined && !!stats?.derived?.includes('reasoningTokens');
    return { share: Math.min(1, Math.max(0, reasoningTokens / outputTokens)), basis: 'tokens', estimated };
  }
  const { reasoningMs, outputMs } = stats ?? {};
  if (!finite(reasoningMs) || !finite(outputMs) || outputMs <= 0) return null;
  if (stats?.derived?.includes('reasoningMs')) return null;
  return { share: Math.min(1, Math.max(0, reasoningMs / outputMs)), basis: 'time', estimated: false };
}

const significant = (ms: number | undefined): ms is number => finite(ms) && ms >= REPLY_STATS_SIGNIFICANT_WAIT_MS;

/**
 * The model load a server reported and the wait main derived from llama-server timings, each 0
 * where under REPLY_STATS_SIGNIFICANT_WAIT_MS; null with neither. A reply continued on another
 * server can have both.
 */
export function replyLoad(source: ReplyStatsSource): { load: number; wait: number } | null {
  const { stats } = readSource(source);
  const load = significant(stats?.loadMs) ? stats.loadMs : 0;
  const wait = significant(stats?.waitMs) ? stats.waitMs : 0;
  return load > 0 || wait > 0 ? { load, wait } : null;
}

/**
 * Tokens over generation time. A server's own timings where it sent them; otherwise what main
 * timed per request from the stream, which counts the network too and so is an estimate.
 */
export function generationRate(
  source: ReplyStatsSource
): { tokens: number; ms: number; estimated: boolean; untimedTokens?: number; outputTokens?: number } | null {
  const { stats, usage } = readSource(source);
  const rate = usage?.rate;
  if (rate && rate.evalTokens > 0 && rate.evalMs > 0) {
    return {
      tokens: rate.evalTokens,
      ms: rate.evalMs,
      estimated: rate.estimated === true,
      untimedTokens: rate.untimedTokens,
    };
  }
  const timed = stats?.generation;
  if (!timed || timed.tokens <= 0 || timed.ms <= 0) return null;
  return {
    tokens: timed.tokens,
    ms: timed.ms,
    estimated: true,
    untimedTokens: timed.untimedTokens,
    outputTokens: timed.outputTokens,
  };
}

/**
 * Prompt tokens served from cache, over the whole prompt. A self-hosted server reports cached
 * apart from evaluated tokens in its timings, or (vLLM) inside its prompt count, on the rate or,
 * for a reply too short to rate, on the usage; a hosted one reports cache reads apart from new
 * input and cache writes.
 */
export function cacheReadShare(usage: ChatUsage | null | undefined): number | null {
  if (!usage) return null;
  const rated = usage.rate?.cachedPromptTokens;
  const unrated = usage.cachedPromptTokens;
  if (rated !== undefined || unrated !== undefined) {
    const cached = (rated ?? 0) + (unrated ?? 0);
    const evaluated = usage.rate?.promptTokens;
    const whole = evaluated !== undefined && unrated === undefined ? cached + evaluated : usage.inputTokens;
    return whole !== undefined && whole > 0 ? Math.min(1, cached / whole) : null;
  }
  const read = usage.cacheReadInputTokens;
  if (read === undefined) return null;
  const whole = (usage.inputTokens ?? 0) + read + (usage.cacheCreationInputTokens ?? 0);
  return whole > 0 ? read / whole : null;
}

function stat(
  id: ReplyStatId,
  value: string | null,
  estimate?: string | false,
  note?: string,
  label?: string
): ReplyStat | null {
  if (value === null) return null;
  return {
    id,
    ...(label ? { label } : {}),
    value: estimate ? `~${value}` : value,
    ...(estimate ? { estimate } : {}),
    ...(note ? { note } : {}),
  };
}

/** What a reply's total takes in beyond its model's own work, or leaves out; undefined with nothing to say. */
function totalNote(stats: ChatReplyStats, load: ReturnType<typeof replyLoad>): string | undefined {
  const includes: string[] = [];
  if (finite(stats.toolMs) && stats.toolMs > 0) {
    includes.push(`${formatDuration(stats.toolMs)} running tools and waiting for approval`);
  }
  // With no load from the server, a long first token may hide one: name the wait, never split it.
  if (!load && finite(stats.firstTokenMs) && stats.firstTokenMs >= REPLY_STATS_SIGNIFICANT_WAIT_MS) {
    includes.push(`${formatDuration(stats.firstTokenMs)} waiting for the first token`);
  }
  if (load && load.wait > 0) includes.push(`${formatDuration(load.wait)} of server wait`);
  const parts = [
    ...(includes.length > 0 ? [`includes ${includes.join(', and ')}`] : []),
    ...(load && load.load > 0 ? [`leaves out ${formatDuration(load.load)} of model load`] : []),
  ];
  return parts.length > 0 ? parts.join('; ') : undefined;
}

/**
 * Every stat the source has a value for, in REPLY_STATS order. `live` formats durations in whole
 * seconds, to tick with the status line's clock, and leaves out the total and the speed, which
 * that line shows while the turn runs, and the share, whose model time is not known until the end.
 * A model load or server wait long enough to matter gets its own row; only a load the server
 * reported is left out of the total, as a derived wait can be a connection on every request.
 */
export function replyStats(raw: ReplyStatsSource, { live = false }: { live?: boolean } = {}): ReplyStat[] {
  const source = readSource(raw);
  const { stats, usage } = source;
  const derived = new Set<string>(stats?.derived ?? []);
  const format = live ? formatElapsed : formatDuration;
  const duration = (ms: number | undefined) => (ms !== undefined && Number.isFinite(ms) ? format(ms) : null);
  const thinkingEstimate = derived.has('reasoningMs') && ESTIMATES.thinking;
  const share = live ? null : thinkingShare(source);
  const generation = live ? null : generationRate(source);
  const load = replyLoad(source);
  // The reported load takes the row; a wait beside it is named in the row's note and the total's.
  const loadKind = load && load.load > 0 ? LOAD_KINDS.load : LOAD_KINDS.wait;
  const loadNotes = load
    ? [loadKind.note, load.load > 0 && load.wait > 0 ? `plus ${formatDuration(load.wait)} of server wait` : undefined]
    : [];
  const { firstTokenMs, firstTokenLoadMs, firstTokenWaitMs } = stats ?? {};
  const firstTokenWait = significant(firstTokenLoadMs)
    ? { ms: firstTokenLoadMs, label: LOAD_KINDS.load.label }
    : significant(firstTokenWaitMs)
      ? { ms: firstTokenWaitMs, label: LOAD_KINDS.wait.label }
      : null;
  const cached = cacheReadShare(usage);
  const rate = usage?.rate;
  // The server's count first: while a continued reply runs it covers every run, and the stored
  // one only the earlier runs.
  const reasoningTokens = usage?.reasoningTokens ?? stats?.reasoningTokens;

  const all: Record<ReplyStatId, ReplyStat | null> = {
    thinking: stat('thinking', duration(stats?.reasoningMs), thinkingEstimate),
    total: stat(
      'total',
      stats && !live && finite(stats.totalMs) ? duration(Math.max(0, stats.totalMs - (load?.load ?? 0))) : null,
      false,
      stats && !live ? totalNote(stats, load) : undefined
    ),
    thinkingShare: stat(
      'thinkingShare',
      share && formatShare(share.share),
      share?.estimated && ESTIMATES.thinkingTokens,
      undefined,
      share ? `Thinking (${share.basis})` : undefined
    ),
    thinkingTokens: stat(
      'thinkingTokens',
      reasoningTokens !== undefined ? formatTokens(reasoningTokens) : null,
      usage?.reasoningTokens === undefined && derived.has('reasoningTokens') && ESTIMATES.thinkingTokens
    ),
    tokens: stat(
      'tokens',
      usage?.outputTokens !== undefined ? formatTokens(usage.outputTokens) : null,
      false,
      'thinking and any sub-agents included'
    ),
    speed: stat(
      'speed',
      generation && formatTokenRate({ evalTokens: generation.tokens, evalMs: generation.ms }),
      generation?.estimated && ESTIMATES.speed,
      (generation &&
        untimedOutputNote(
          generation.tokens,
          generation.outputTokens ?? usage?.outputTokens,
          generation.untimedTokens
        )) ||
        undefined
    ),
    cacheShare: stat('cacheShare', cached !== null ? formatShare(cached) : null),
    promptSpeed: stat(
      'promptSpeed',
      rate?.promptTokens !== undefined && rate.promptMs !== undefined
        ? formatTokenRate({ evalTokens: rate.promptTokens, evalMs: rate.promptMs })
        : null
    ),
    firstToken: stat(
      'firstToken',
      finite(firstTokenMs) ? formatDuration(firstTokenMs) : null,
      false,
      firstTokenWait
        ? `includes ${formatDuration(firstTokenWait.ms)} of ${firstTokenWait.label.toLowerCase()}`
        : undefined
    ),
    load:
      load &&
      stat(
        'load',
        formatDuration(load.load > 0 ? load.load : load.wait),
        false,
        loadNotes.filter(Boolean).join('; ') || undefined,
        loadKind.label
      ),
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

export function statLabel(row: ReplyStat): string {
  return row.label ?? REPLY_STAT_TEXT[row.id].label;
}

/** One line per stat, label first, with what each estimate rests on; for a native title. */
export function describeReplyStats(rows: readonly ReplyStat[]): string | null {
  if (rows.length === 0) return null;
  return rows
    .map(row => {
      const detail = statDetail(row);
      return `${statLabel(row)}: ${row.value}${detail ? ` (${detail})` : ''}`;
    })
    .join('\n');
}

/** The rows as one sentence for a screen reader, a leading ~ read as "about". */
export function speakReplyStats(rows: readonly ReplyStat[], credits: string | null): string {
  const parts = rows.map(row => {
    const detail = statDetail(row);
    const value = row.value.startsWith('~') ? `about ${row.value.slice(1)}` : row.value;
    return `${statLabel(row)} ${value}${detail ? `, ${detail}` : ''}`;
  });
  if (credits) parts.push(`Cost ${credits}`);
  return `${parts.join('; ')}.`;
}

/**
 * What a reply in flight has measured so far, in the shape a settled one stores, on top of
 * `earlier`: a continued reply's stats from the runs before this one. Only the thinking time and
 * the first token are live; the rest is zero and left out of the live rail.
 */
export function liveReplyStats(turn: TurnProgress, now: number, stored?: unknown): ChatReplyStats {
  const earlier = readReplyStats(stored);
  const open = turn.thinkingSince !== undefined ? Math.max(0, now - turn.thinkingSince) : 0;
  const thought = turn.thinkingMs !== undefined || turn.thinkingSince !== undefined;
  const reasoningMs = thought ? (earlier?.reasoningMs ?? 0) + (turn.thinkingMs ?? 0) + open : earlier?.reasoningMs;
  const { firstTokenAt, requestAt } = turn;
  // Never from the turn's start, which would count its setup as waiting on the model.
  const firstTokenMs =
    earlier?.firstTokenMs ??
    (firstTokenAt !== undefined && typeof requestAt === 'number' ? Math.max(0, firstTokenAt - requestAt) : undefined);
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
