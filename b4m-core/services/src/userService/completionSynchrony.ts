import { COMPLETION_SEQUENCE_SCAN_LIMIT, type ApiCompletionOutcome } from '@bike4mind/common';

export type CompletionSynchronyEvent = {
  eventId: string;
  userId: string;
  at: Date;
  requestedModel: string;
  outcome: ApiCompletionOutcome;
  eligible?: boolean;
};
export const COMPLETION_SYNCHRONY_POLICY = {
  maxSkewMs: 1_500,
  minAccounts: 3,
  maxAccounts: 10,
  minBursts: 3,
  minGapMs: 30_000,
  maxGapMs: 30 * 60_000,
  maxWindows: 20_000,
  maxPatterns: 50,
} as const;

type Burst = { events: CompletionSynchronyEvent[]; first: number; last: number; model: string };
export type CompletionSynchronyPattern = {
  userIds: string[];
  bursts: number;
  synchronizedModelSwitches: number;
  distinctRequestedModels: number;
  maxStartSkewMilliseconds: number;
  completedRequests: number;
  dailyCapRejectedRequests: number;
  otherRejectedRequests: number;
  interruptedOrUnknownRequests: number;
  firstObservedAt: Date;
  lastObservedAt: Date;
};

function* memberSubsets(
  events: CompletionSynchronyEvent[],
  from = 0,
  selected: CompletionSynchronyEvent[] = []
): Generator<CompletionSynchronyEvent[]> {
  if (selected.length >= COMPLETION_SYNCHRONY_POLICY.minAccounts) yield selected;
  if (selected.length >= COMPLETION_SYNCHRONY_POLICY.maxAccounts) return;
  for (let index = from; index < events.length; index++)
    yield* memberSubsets(events, index + 1, [...selected, events[index]]);
}

function summarize(userIds: string[], bursts: Burst[]): CompletionSynchronyPattern {
  const events = bursts.flatMap(burst => burst.events);
  const count = (predicate: (event: CompletionSynchronyEvent) => boolean) => events.filter(predicate).length;
  return {
    userIds,
    bursts: bursts.length,
    synchronizedModelSwitches: bursts.slice(1).filter((burst, index) => burst.model !== bursts[index].model).length,
    distinctRequestedModels: new Set(bursts.map(burst => burst.model)).size,
    maxStartSkewMilliseconds: Math.max(...bursts.map(burst => burst.last - burst.first)),
    completedRequests: count(event => event.outcome === 'completed'),
    dailyCapRejectedRequests: count(event => event.outcome === 'daily_cap_rejected'),
    otherRejectedRequests: count(event => event.outcome === 'rejected' || event.outcome === 'failed'),
    interruptedOrUnknownRequests: count(event => event.outcome === 'interrupted' || event.outcome === 'unknown'),
    firstObservedAt: new Date(bursts[0].first),
    lastObservedAt: new Date(bursts.at(-1)!.last),
  };
}

/** Finds repeated start-time coincidence, independently of settlement order or existing flags. */
export function findCompletionSynchrony(input: readonly CompletionSynchronyEvent[]) {
  const policy = COMPLETION_SYNCHRONY_POLICY;
  const unique = new Map<string, CompletionSynchronyEvent>();
  for (const event of input.slice(0, COMPLETION_SEQUENCE_SCAN_LIMIT)) {
    if (!Number.isFinite(event.at.getTime()) || !event.requestedModel || event.eligible === false) continue;
    if (!unique.has(event.eventId)) unique.set(event.eventId, event);
  }
  const events = [...unique.values()].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || a.eventId.localeCompare(b.eventId)
  );
  const candidates = new Map<string, { userIds: string[]; bursts: Burst[] }>();
  let truncated = input.length > COMPLETION_SEQUENCE_SCAN_LIMIT;
  let windows = 0;
  outer: for (let start = 0; start < events.length; start++) {
    const first = events[start];
    const byUser = new Map<string, CompletionSynchronyEvent>();
    for (let end = start; end < events.length; end++) {
      const event = events[end];
      if (event.at.getTime() - first.at.getTime() > policy.maxSkewMs) break;
      if (++windows > policy.maxWindows) {
        truncated = true;
        break;
      }
      if (event.requestedModel !== first.requestedModel) continue;
      if (!byUser.has(event.userId)) byUser.set(event.userId, event);
    }
    if (truncated && windows > policy.maxWindows) break;
    if (byUser.size < policy.minAccounts) continue;
    if (byUser.size > policy.maxAccounts) {
      truncated = true;
      continue;
    }
    // Repeated subsets survive incidental traffic without requiring an existing flagged seed.
    for (const selected of memberSubsets([...byUser.values()].sort((a, b) => a.userId.localeCompare(b.userId)))) {
      if (++windows > policy.maxWindows) {
        truncated = true;
        break outer;
      }
      const userIds = selected.map(event => event.userId);
      const key = JSON.stringify(userIds);
      const candidate = candidates.get(key) ?? { userIds, bursts: [] };
      candidate.bursts.push({
        events: selected,
        first: Math.min(...selected.map(event => event.at.getTime())),
        last: Math.max(...selected.map(event => event.at.getTime())),
        model: first.requestedModel,
      });
      candidates.set(key, candidate);
    }
  }
  const patterns: CompletionSynchronyPattern[] = [];
  for (const { userIds, bursts } of candidates.values()) {
    let episode: Burst[] = [];
    const finish = () => {
      if (episode.length >= policy.minBursts) patterns.push(summarize(userIds, episode));
    };
    for (const burst of bursts) {
      const previous = episode.at(-1);
      if (previous && burst.first - previous.last < policy.minGapMs) continue;
      if (previous && burst.first - previous.last > policy.maxGapMs) {
        finish();
        episode = [];
      }
      episode.push(burst);
    }
    finish();
  }
  const ranked = patterns.sort(
    (a, b) =>
      b.userIds.length - a.userIds.length ||
      b.bursts - a.bursts ||
      a.firstObservedAt.getTime() - b.firstObservedAt.getTime()
  );
  const maximal: CompletionSynchronyPattern[] = [];
  for (const pattern of ranked) {
    if (
      maximal.some(
        kept =>
          pattern.userIds.every(id => kept.userIds.includes(id)) &&
          pattern.firstObservedAt >= kept.firstObservedAt &&
          pattern.lastObservedAt <= kept.lastObservedAt
      )
    )
      continue;
    maximal.push(pattern);
  }
  return {
    patterns: maximal.slice(0, policy.maxPatterns),
    truncated: truncated || maximal.length > policy.maxPatterns,
  };
}
