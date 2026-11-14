import {
  isLocalModel,
  parseLocalModelId,
  type ChatMessage,
  type ChatSession,
  type ChatTokenRate,
  type ChatUsage,
} from '@shared/chat';
import { LOCAL_SERVER_NAME, serverIdOfRuntime } from '@shared/modelServers';
import type { LocalUsage, LocalUsageBar, LocalUsageFigures, LocalUsageRow, UsageWindowId } from '@shared/usage';
import { addTokenRate } from '../chat/tokenRate';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const LOCAL_RUNTIME_ID = 'ollama';
export const REMOVED_SERVER_LABEL = 'Removed server';

/** One session's replies from one local model within one UTC hour. */
export interface LocalUsageBucket extends LocalUsageFigures {
  /** The full `local:<runtime>:<model>` id. */
  model: string;
  /** Start of the UTC hour, epoch ms. */
  hour: number;
}

const FIGURE_KEYS = [
  'replies',
  'outputTokens',
  'contextTokens',
  'timedReplies',
  'evalTokens',
  'evalMs',
  'estimatedReplies',
  'estimatedEvalTokens',
  'estimatedEvalMs',
  'promptTokens',
  'promptMs',
  'loads',
  'loadMs',
  'draftTokens',
  'draftAccepted',
] as const satisfies readonly (keyof LocalUsageFigures)[];

export function emptyFigures(): LocalUsageFigures {
  return Object.fromEntries(FIGURE_KEYS.map(key => [key, 0])) as unknown as LocalUsageFigures;
}

function addFigures(into: LocalUsageFigures, from: LocalUsageFigures): void {
  for (const key of FIGURE_KEYS) into[key] += from[key];
}

function amount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The tokens and speed sums of one slice of a reply's usage. Older session files predate every field. */
function usageFigures(usage: ChatUsage): LocalUsageFigures {
  const figures = emptyFigures();
  figures.outputTokens = amount(usage?.outputTokens);
  figures.contextTokens = amount(usage?.inputTokens);
  const rate = usage?.rate;
  const evalTokens = amount(rate?.evalTokens);
  const evalMs = amount(rate?.evalMs);
  if (!rate || evalTokens === 0 || evalMs === 0) return figures;
  if (rate.estimated) {
    figures.estimatedEvalTokens = evalTokens;
    figures.estimatedEvalMs = evalMs;
    return figures;
  }
  figures.evalTokens = evalTokens;
  figures.evalMs = evalMs;
  const promptTokens = amount(rate.promptTokens);
  const promptMs = amount(rate.promptMs);
  if (promptTokens > 0 && promptMs > 0) {
    figures.promptTokens = promptTokens;
    figures.promptMs = promptMs;
  }
  const draftTokens = amount(rate.draftTokens);
  if (draftTokens > 0) {
    figures.draftTokens = draftTokens;
    figures.draftAccepted = Math.min(amount(rate.draftAccepted), draftTokens);
  }
  return figures;
}

/** The counts one reply adds, from its whole usage on the model it started on. */
function replyFigures(usage: ChatUsage): LocalUsageFigures {
  const figures = emptyFigures();
  figures.replies = 1;
  const rate = usage?.rate;
  if (!rate || amount(rate.evalTokens) === 0 || amount(rate.evalMs) === 0) return figures;
  if (rate.estimated) {
    figures.estimatedReplies = 1;
    return figures;
  }
  figures.timedReplies = 1;
  const loadMs = amount(rate.loadMs);
  if (loadMs > 0) {
    figures.loads = 1;
    figures.loadMs = loadMs;
  }
  return figures;
}

/**
 * The model a reply started on, or null. Unstamped: its snapshot's model, else the session's if it has a rate.
 * Null when hosted (prompt-cache stamp) or when only rounds are stamped: a continuation's snapshot is not its start.
 */
function replyModel(message: ChatMessage, sessionModel: string): string | null {
  if (typeof message.model === 'string') return message.model;
  if (message.promptCache) return null;
  if (Array.isArray(message.rounds) && message.rounds.some(round => typeof round?.model === 'string')) return null;
  const snapshot = message.contextSnapshot?.model;
  if (typeof snapshot === 'string' && snapshot) return snapshot;
  return message.usage?.rate ? sessionModel : null;
}

function addShare(total: ChatUsage | undefined, next: ChatUsage): ChatUsage {
  const rate = addTokenRate(total?.rate, next.rate);
  return {
    outputTokens: amount(total?.outputTokens) + amount(next.outputTokens),
    inputTokens: amount(total?.inputTokens) + amount(next.inputTokens),
    ...(rate ? { rate } : {}),
  };
}

const RATE_KEYS = [
  'evalTokens',
  'evalMs',
  'promptTokens',
  'promptMs',
  'loadMs',
  'draftTokens',
  'draftAccepted',
] as const satisfies readonly (keyof ChatTokenRate)[];

/** What `whole` holds beyond `parts`. A reply split across models gets no rate: it belongs to none of them. */
function usageBeyond(whole: ChatUsage, parts: ChatUsage[], withRate: boolean): ChatUsage {
  const carried = (read: (usage: ChatUsage) => unknown) => parts.reduce((sum, part) => sum + amount(read(part)), 0);
  const rest: ChatUsage = {
    outputTokens: Math.max(0, amount(whole.outputTokens) - carried(part => part.outputTokens)),
    inputTokens: Math.max(0, amount(whole.inputTokens) - carried(part => part.inputTokens)),
  };
  if (!withRate || !whole.rate) return rest;
  const rate: ChatTokenRate = { evalTokens: 0, evalMs: 0, ...(whole.rate.estimated ? { estimated: true } : {}) };
  for (const key of RATE_KEYS) {
    rate[key] = Math.max(0, amount(whole.rate[key]) - carried(part => part.rate?.[key]));
  }
  return { ...rest, rate };
}

type HourlyUsage = Map<number, ChatUsage>;

function addAt(shares: Map<string | null, HourlyUsage>, model: string | null, hour: number, usage: ChatUsage): void {
  let hours = shares.get(model);
  if (!hours) {
    hours = new Map();
    shares.set(model, hours);
  }
  hours.set(hour, addShare(hours.get(hour), usage));
}

function hourOf(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

/**
 * A reply's usage per model and UTC hour: each round where it ended, the rest in the hour it was first stored.
 * `message.usage` stays whole unless the rounds name different models. `replyLevel` always has a share.
 */
function replyShares(
  message: ChatMessage & { usage: ChatUsage },
  replyLevel: string | null,
  startHour: number
): Map<string | null, HourlyUsage> {
  const rounds = Array.isArray(message.rounds)
    ? message.rounds.filter(round => round && typeof round === 'object')
    : [];
  const modelOf = (round: (typeof rounds)[number]): string | null =>
    typeof round.model === 'string' ? round.model : replyLevel;
  const spread = new Set(rounds.map(modelOf)).size >= 2;

  const shares = new Map<string | null, HourlyUsage>();
  const carried: ChatUsage[] = [];
  for (const round of rounds) {
    if (!round.usage || typeof round.usage !== 'object') continue;
    const endedAt = round.timing?.endedAt;
    const hour = typeof endedAt === 'number' && Number.isFinite(endedAt) ? hourOf(endedAt) : startHour;
    addAt(shares, spread ? modelOf(round) : replyLevel, hour, round.usage);
    carried.push(round.usage);
  }
  // What no round carries: an explore sub-loop's spend (hosted only) or a fallback round for a
  // reply stored without rounds, which ran on the model the reply started on.
  const allLocal = [...shares.keys()].every(model => model !== null && isLocalModel(model));
  if (!spread || allLocal) addAt(shares, replyLevel, startHour, usageBeyond(message.usage, carried, !spread));
  if (!shares.has(replyLevel)) addAt(shares, replyLevel, startHour, {});
  return shares;
}

/** A session's local replies, bucketed by model and UTC hour. */
export function sessionUsageBuckets(session: Pick<ChatSession, 'model' | 'messages'>): LocalUsageBucket[] {
  const buckets = new Map<string, LocalUsageBucket>();
  const bucketAt = (model: string, hour: number): LocalUsageBucket => {
    const key = `${hour}\n${model}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { model, hour, ...emptyFigures() };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  for (const message of session.messages) {
    if (message?.role !== 'assistant' || !message.usage || typeof message.usage !== 'object') continue;
    const at = Date.parse(message.createdAt);
    if (!Number.isFinite(at)) continue;
    const startHour = hourOf(at);
    const started = replyModel(message, session.model);
    for (const [model, hours] of replyShares(message as ChatMessage & { usage: ChatUsage }, started, startHour)) {
      if (!model || !isLocalModel(model) || !parseLocalModelId(model)) continue;
      let whole: ChatUsage = {};
      for (const [hour, usage] of hours) {
        addFigures(bucketAt(model, hour), usageFigures(usage));
        whole = addShare(whole, usage);
      }
      if (model === started) addFigures(bucketAt(model, startHour), replyFigures(whole));
    }
  }
  return [...buckets.values()];
}

/** Whether a bucket read back from the index has every field this version writes. */
export function isLocalUsageBucket(value: unknown): value is LocalUsageBucket {
  if (!value || typeof value !== 'object') return false;
  const bucket = value as Record<string, unknown>;
  return (
    typeof bucket.model === 'string' &&
    Number.isFinite(bucket.hour) &&
    FIGURE_KEYS.every(key => typeof bucket[key] === 'number' && Number.isFinite(bucket[key]))
  );
}

/**
 * "This computer", a saved server's current name, or `REMOVED_SERVER_LABEL` once it is gone.
 * Null `serverNames` means the saved servers could not be read, so a server keeps its runtime id.
 */
export function serverLabel(runtimeId: string, serverNames: ReadonlyMap<string, string> | null): string {
  if (runtimeId === LOCAL_RUNTIME_ID) return LOCAL_SERVER_NAME;
  const serverId = serverIdOfRuntime(runtimeId);
  if (serverId === null || !serverNames) return runtimeId;
  return serverNames.get(serverId) ?? REMOVED_SERVER_LABEL;
}

function utcDayStart(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}

interface RowTotals {
  label: string;
  figures: LocalUsageFigures;
}

function toRows(rows: Map<string, RowTotals>): LocalUsageRow[] {
  return [...rows.entries()]
    .map(([key, { label, figures }]) => ({
      key,
      label,
      replies: figures.replies,
      outputTokens: figures.outputTokens,
      evalTokens: figures.evalTokens,
      evalMs: figures.evalMs,
      estimatedEvalTokens: figures.estimatedEvalTokens,
      estimatedEvalMs: figures.estimatedEvalMs,
    }))
    .sort((a, b) => b.outputTokens - a.outputTokens || b.replies - a.replies || a.label.localeCompare(b.label));
}

function addToRow(rows: Map<string, RowTotals>, key: string, label: string, figures: LocalUsageFigures): void {
  let row = rows.get(key);
  if (!row) {
    row = { label, figures: emptyFigures() };
    rows.set(key, row);
  }
  addFigures(row.figures, figures);
}

/**
 * One window of local usage out of the hour buckets: UTC hour or day bars (days + 1, as the credit chart's).
 * Every total is summed from exactly the buckets the bars draw, so the headline matches the chart.
 */
export function localUsageWindow(
  buckets: Iterable<LocalUsageBucket>,
  window: UsageWindowId,
  now: number,
  serverNames: ReadonlyMap<string, string> | null
): Omit<LocalUsage, 'readAt' | 'scope'> {
  const hourly = window === 'last-24-hours';
  const step = hourly ? HOUR_MS : DAY_MS;
  const first = hourly ? Math.floor(now / HOUR_MS) * HOUR_MS - 23 * HOUR_MS : utcDayStart(now - 30 * DAY_MS);
  const count = hourly ? 24 : (utcDayStart(now) - first) / DAY_MS + 1;
  const bars: LocalUsageBar[] = Array.from({ length: count }, (_, index) => ({
    startsAt: new Date(first + index * step).toISOString(),
    replies: 0,
    outputTokens: 0,
  }));
  const totals = emptyFigures();
  const byModel = new Map<string, RowTotals>();
  const byServer = new Map<string, RowTotals>();
  let allTimeReplies = 0;

  for (const bucket of buckets) {
    allTimeReplies += bucket.replies;
    const index = Math.floor((bucket.hour - first) / step);
    if (index < 0 || index >= count) continue;
    bars[index].replies += bucket.replies;
    bars[index].outputTokens += bucket.outputTokens;
    addFigures(totals, bucket);
    const parsed = parseLocalModelId(bucket.model);
    if (!parsed) continue;
    addToRow(byModel, parsed.model, parsed.model, bucket);
    const server = serverLabel(parsed.runtimeId, serverNames);
    addToRow(byServer, server === REMOVED_SERVER_LABEL ? 'removed' : parsed.runtimeId, server, bucket);
  }

  return {
    window,
    granularity: hourly ? 'hour' : 'day',
    bars,
    totals,
    byModel: toRows(byModel),
    byServer: toRows(byServer),
    allTimeReplies,
  };
}
