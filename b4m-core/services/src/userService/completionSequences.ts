import {
  COMPLETION_SEQUENCE_MIN_ACCOUNTS,
  COMPLETION_SEQUENCE_MAX_ACCOUNTS,
  COMPLETION_SEQUENCE_SCAN_LIMIT,
} from '@bike4mind/common';

export type CompletionSequenceEvent = { userId: string; requestId: string; at: Date; eligible?: boolean };
export type CompletionSequencePattern = {
  userIds: string[];
  rounds: number;
  minRequestsPerRound: number;
  maxRequestsPerRound: number;
  maxRoundSpanSeconds: number;
  minGapSeconds: number;
  maxGapSeconds: number;
  firstObservedAt: Date;
  lastObservedAt: Date;
};

export const COMPLETION_SEQUENCE_POLICY = {
  maxRoundMs: 120_000,
  minGapMs: 30_000,
  maxGapMs: 30 * 60_000,
  maxRequestsPerAccountRun: 3,
  maxCandidateWindows: 20_000,
  maxPatterns: 50,
} as const;

type Run = { userId: string; first: number; last: number; count: number; ambiguous: boolean };
type Round = { first: number; last: number; from: number; to: number; count: number };
type Candidate = { userIds: string[]; rounds: Round[] };

function eventRuns(events: readonly CompletionSequenceEvent[]): Run[] {
  const unique = new Map<string, CompletionSequenceEvent>();
  for (const event of events) {
    if (!Number.isFinite(event.at.getTime())) continue;
    const key = JSON.stringify([event.userId, event.requestId]);
    const previous = unique.get(key);
    if (!previous || event.at < previous.at) unique.set(key, event);
  }
  const sorted = [...unique.values()].sort((left, right) => left.at.getTime() - right.at.getTime());
  const runs: Run[] = [];
  for (const event of sorted) {
    const at = event.at.getTime();
    if (event.eligible === false) {
      runs.push({ userId: '', first: at, last: at, count: 1, ambiguous: true });
      continue;
    }
    const previous = runs.at(-1);
    if (previous?.userId === event.userId) {
      previous.last = at;
      previous.count += 1;
    } else {
      const ambiguous = previous?.last === at;
      if (previous && ambiguous) previous.ambiguous = true;
      runs.push({ userId: event.userId, first: at, last: at, count: 1, ambiguous });
    }
  }
  return runs;
}

function toPattern(userIds: string[], rounds: Round[]): CompletionSequencePattern {
  const gaps = rounds.slice(1).map((round, index) => round.first - rounds[index].last);
  return {
    userIds,
    rounds: rounds.length,
    minRequestsPerRound: Math.min(...rounds.map(round => round.count)),
    maxRequestsPerRound: Math.max(...rounds.map(round => round.count)),
    maxRoundSpanSeconds: Math.max(...rounds.map(round => round.last - round.first)) / 1_000,
    minGapSeconds: Math.min(...gaps) / 1_000,
    maxGapSeconds: Math.max(...gaps) / 1_000,
    firstObservedAt: new Date(rounds[0].first),
    lastObservedAt: new Date(rounds.at(-1)!.last),
  };
}

function repeatedEpisodes(candidate: Candidate): CompletionSequencePattern[] {
  const patterns: CompletionSequencePattern[] = [];
  let episode: Round[] = [];
  const finish = () => {
    if (episode.length >= 2) patterns.push(toPattern(candidate.userIds, episode));
  };
  for (const round of candidate.rounds) {
    const previous = episode.at(-1);
    if (previous && round.from <= previous.to) continue;
    if (previous && round.first - previous.last < COMPLETION_SEQUENCE_POLICY.minGapMs) continue;
    if (previous && round.first - previous.last > COMPLETION_SEQUENCE_POLICY.maxGapMs) {
      finish();
      episode = [];
    }
    episode.push(round);
  }
  finish();
  return patterns;
}

/** Uses contiguous recorded runs. Unrelated interleaving is never silently filtered away. */
export function findCompletionSequences(events: readonly CompletionSequenceEvent[]) {
  const runs = eventRuns(events.slice(0, COMPLETION_SEQUENCE_SCAN_LIMIT));
  const candidates = new Map<string, Candidate>();
  let windows = 0;
  let truncated = events.length > COMPLETION_SEQUENCE_SCAN_LIMIT;
  outer: for (let start = 0; start < runs.length; start++) {
    const members: string[] = [];
    let count = 0;
    for (let end = start; end < Math.min(runs.length, start + COMPLETION_SEQUENCE_MAX_ACCOUNTS); end++) {
      const run = runs[end];
      if (
        run.ambiguous ||
        run.count > COMPLETION_SEQUENCE_POLICY.maxRequestsPerAccountRun ||
        members.includes(run.userId)
      )
        break;
      if (run.last - runs[start].first > COMPLETION_SEQUENCE_POLICY.maxRoundMs) break;
      members.push(run.userId);
      count += run.count;
      if (members.length < COMPLETION_SEQUENCE_MIN_ACCOUNTS) continue;
      if (++windows > COMPLETION_SEQUENCE_POLICY.maxCandidateWindows) {
        truncated = true;
        break outer;
      }
      const key = JSON.stringify(members);
      const candidate = candidates.get(key) ?? { userIds: [...members], rounds: [] };
      candidate.rounds.push({ first: runs[start].first, last: run.last, from: start, to: end, count });
      candidates.set(key, candidate);
    }
  }
  const ranked = [...candidates.values()]
    .flatMap(repeatedEpisodes)
    .sort(
      (left, right) =>
        right.userIds.length - left.userIds.length ||
        right.rounds - left.rounds ||
        left.firstObservedAt.getTime() - right.firstObservedAt.getTime() ||
        left.userIds.join().localeCompare(right.userIds.join())
    );
  const maximal: CompletionSequencePattern[] = [];
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
    patterns: maximal.slice(0, COMPLETION_SEQUENCE_POLICY.maxPatterns),
    truncated: truncated || maximal.length > COMPLETION_SEQUENCE_POLICY.maxPatterns,
    candidateWindows: windows,
    ambiguousTimestamps: runs.some(run => run.ambiguous),
  };
}
