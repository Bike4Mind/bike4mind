import type {
  IDataLakeProposalDocument,
  LegacyResearchRunLevers,
  ResearchFeedCursor,
  ResearchRunStopReason,
  ResearchRunTotals,
} from '@bike4mind/common';
import {
  emptyResearchRunTotals,
  researchFeedFingerprint,
  researchFeedUrlKey,
  RESEARCH_FEED_MAX_RETRIES,
  RESEARCH_FEED_SEEN_KEYS_MAX,
  RESEARCH_RUN_PRODUCER,
  upgradeLegacyResearchLevers,
} from '@bike4mind/common';
import { isPlaceholderTitle } from '@bike4mind/fab-pipeline';
import { trustedEntryCoversHost } from '@bike4mind/utils/registrableDomain';
import { canonicalSourceKey } from '../dataLakeService/canonicalSourceKey';
import type { ProposalCandidate, ProposalOutcome } from '../dataLakeService/proposeDataLakeContent';
import type { FeedItem } from './parseFeed';
import type { RelevanceJudgement } from './RelevanceJudgeService';
import { feedCursorMode, selectFeedCandidates } from './selectFeedCandidates';
import { classifySource, isQueueableVerdict, matchSource, sourceHostname } from './sourceFilter';

/**
 * The run loop (#1682): search -> filter by source -> judge -> fetch -> propose, once per candidate,
 * until the candidates run out or a lever stops it.
 *
 * PURE ORCHESTRATION. Every effect is a port, so the ordering rules below - which are the whole
 * value of this function - are testable without a network, a model or a database. Those rules:
 *
 *  1. The FREE filter runs first. The source lists drop a candidate before a judgment and before a
 *     fetch, so a narrow site list costs nothing to enforce.
 *  2. The ceiling is checked BEFORE each judgment, never after. Checking after would always
 *     overspend by one call, and one call is the entire budget of a small ceiling.
 *  3. The fetch happens only after the judgment clears. Fetching first would be cheaper in latency
 *     and more expensive in bandwidth on exactly the candidates we are about to discard.
 *  4. The proposal limit is checked after each successful proposal, so a run that hits it has
 *     produced exactly `maxProposals` cards and not one more.
 *
 * It never writes a FabFile and never stamps a lake tag itself. The only write it causes is a
 * `pending` proposal, and a human approving that is what admits content, with one exception: when the
 * config opted in, a first-time proposal from a trusted-site entry is handed to the `autoAdmit` port.
 * That decision is by source tier alone, never by score.
 */

/**
 * One normalized search hit. Structurally the search providers' `WebSearchProviderResult`. Feed
 * items carry the optional fields; the search path never sets them.
 */
export interface ResearchCandidate {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: Date;
  authors?: string[];
  categories?: string[];
}

/** A feed could not be read. `message` is written for a lake manager and becomes the run's error. */
export class FeedUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedUnavailableError';
  }
}

/** What a fetch produced, honoring the queue's extraction contract. See `fetchSource` below. */
export interface FetchedSource {
  title: string;
  /** The url after redirects, which the title was derived from; may differ from the hit url. */
  finalUrl: string;
  /**
   * The extracted text, or undefined when the door cannot produce text comparable with what the
   * INGESTION door would extract from the same URL. Undefined is a real answer, not a failure: the
   * candidate is still proposed, on source-keyed dedup alone.
   */
  text?: string;
}

export interface AutoAdmitRule {
  /** The trusted-list entry covering `finalUrl` (and not sitting above its registrable domain), else null. */
  isTrusted(finalUrl: string): string | null;
}

export interface ResearchRunPorts {
  /** Ask the search provider for up to `maxResults` hits, honoring the recency lever. */
  search(query: string, maxResults: number, recencyDays?: number): Promise<ResearchCandidate[]>;
  /**
   * Read and parse a feed. Absent on a caller that cannot fetch one, which fails a feed run rather
   * than falling back to search. Throws `FeedUnavailableError` when the feed cannot be used.
   */
  readFeed?(url: string): Promise<FeedItem[]>;
  /**
   * Score one candidate 0..1 and report what the judgment cost. A `failed` outcome drops the
   * candidate, so a broken model proposes nothing rather than everything, but it is counted as
   * `judgeFailed` rather than `belowRelevance` so the run card says "the model was down" and not
   * "the web had nothing".
   */
  judge(candidate: ResearchCandidate): Promise<RelevanceJudgement>;
  /**
   * Retrieve the page. MUST use the same extractor the ingestion door uses
   * (`fetchAndParseURL` -> the chunker's text branch) or both of the queue's text-hash comparisons
   * silently miss - see `ProposalCandidate.text`. Null when the page could not be fetched.
   */
  fetchSource(url: string): Promise<FetchedSource | null>;
  /** Hand the candidate to `proposeDataLakeContent`. The ONLY write this loop can cause. */
  propose(candidate: ProposalCandidate): Promise<ProposalOutcome>;
  /**
   * Admit a just-proposed row on the authority of the trusted-site list. Present only when the
   * caller can act as the lake's owner; absent, nothing auto-admits. `rule.isTrusted` is the
   * admit-time check on the page the fetch lands on. Must not throw: a failure is `left_pending`.
   */
  autoAdmit?(proposal: IDataLakeProposalDocument, rule: AutoAdmitRule): Promise<'admitted' | 'left_pending'>;
  /** Report progress mid-loop so the panel is not blank while a run works. Best-effort. */
  onProgress?(spentMicroUsd: number, totals: ResearchRunTotals): Promise<void>;
  now(): Date;
  /**
   * Milliseconds of execution time left. The loop stops cleanly at `timeBudgetReserveMs` rather
   * than being killed mid-candidate, which would leave the run `running` forever until a redelivery
   * found it un-claimable. Absent -> no time bound (a test, or a long-lived worker).
   */
  remainingTimeMs?(): number;
}

export interface ResearchRunResult {
  totals: ResearchRunTotals;
  spentMicroUsd: number;
  stopReason: ResearchRunStopReason;
  /**
   * The judge step failed outright: at least one judgment was attempted and none produced a score.
   * Such a run proposed nothing because of the model, not the web, so the caller settles it as
   * `failed` with `judgeError` rather than as a clean run with an empty result.
   */
  judgeStepFailed: boolean;
  /** The first failed judgment's message, when any judgment failed. */
  judgeError?: string;
  /**
   * Feed runs only: what the next run needs to resume. The caller decides whether to store it. When
   * the judge step failed, only `retries` differs from the stored cursor; absent if none was active.
   */
  feedCursor?: ResearchFeedCursor;
  /** Feed runs only: eligible items left for a later run. Outside `totals`: a waiting item is not an outcome. */
  feedBacklog?: number;
}

/**
 * Stop this far short of the deadline. One candidate is a judgment plus a fetch plus a proposal
 * write, and the fetch alone can take the URL fetcher's full timeout, so the reserve has to cover a
 * whole iteration rather than just the write at the end of it.
 */
const TIME_BUDGET_RESERVE_MS = 90_000;

/** Judge failures, with nothing scored yet, after which the judge is treated as down for the run. */
const JUDGE_BREAKER_FAILURES = 3;

/**
 * Every propose-step outcome, each one a final answer for a feed item. Typed against the union so a
 * new outcome fails the compiler here instead of defaulting to settled.
 */
export const SETTLED_PROPOSE_OUTCOMES = {
  proposed: true,
  duplicate_pending: true,
  already_in_lake: true,
  suppressed_by_tombstone: true,
  unusable_source: true,
} as const satisfies Record<ProposalOutcome['outcome'], true>;

type FeedItemState = 'settled' | 'transient';

/**
 * The trusted-list entry that admits `url`, or null. Shared by the run and by the worker's live
 * re-check, so both apply the same host-coverage rule.
 */
export function trustedEntryForUrl(url: string, rules: Parameters<typeof matchSource>[1]): string | null {
  const match = matchSource(url, rules);
  const host = sourceHostname(url);
  return match.verdict === 'trusted' && match.entry && host && trustedEntryCoversHost(match.entry, host)
    ? match.entry
    : null;
}

export async function executeResearchRun(
  storedLevers: LegacyResearchRunLevers,
  runId: string,
  ports: ResearchRunPorts,
  storedFeedCursor?: ResearchFeedCursor | null
): Promise<ResearchRunResult> {
  // A run snapshot can predate the tiers, so it is upgraded here rather than trusted to be current.
  const levers = upgradeLegacyResearchLevers(storedLevers);
  const totals = emptyResearchRunTotals();
  let spentMicroUsd = 0;
  let scored = 0;
  let judgeError: string | undefined;

  const outOfTime = (): boolean =>
    ports.remainingTimeMs !== undefined && ports.remainingTimeMs() <= TIME_BUDGET_RESERVE_MS;

  const isFeed = levers.source === 'feed';
  const feedStates = new Map<string, FeedItemState>();
  const settledKeys: string[] = [];
  let feedKeysInFeed = new Set<string>();
  let feedSkipped: string[] = [];
  let feedBacklog = 0;
  const markFeedItem = (candidate: ResearchCandidate, state: FeedItemState): void => {
    if (!isFeed) return;
    const key = canonicalSourceKey(candidate.url);
    if (!key) return;
    feedStates.set(key, state);
    if (state === 'settled') settledKeys.push(key);
  };

  const buildFeedCursor = (
    candidates: ResearchCandidate[],
    judgeStepFailed: boolean
  ): ResearchFeedCursor | undefined => {
    const fingerprint = researchFeedFingerprint(levers);
    const mode = feedCursorMode(storedFeedCursor, levers);
    // A judge outage must not settle anything, so only an active cursor can take its retry counts.
    if (judgeStepFailed && mode !== 'active') return undefined;
    // Same feed under other settings: the old retries, seen keys and floor carry over.
    const base = mode === 'fresh' ? null : storedFeedCursor!;
    const oldAttempts = new Map((base?.retries ?? []).map(retry => [retry.key, retry.attempts]));

    const nextRetries: ResearchFeedCursor['retries'] = [];
    const givenUp: string[] = [];
    const dated: { at: number; state: FeedItemState | 'unreached' | 'given_up' }[] = [];
    for (const candidate of candidates) {
      const key = canonicalSourceKey(candidate.url);
      if (!key) continue;
      let state: FeedItemState | 'unreached' | 'given_up' = feedStates.get(key) ?? 'unreached';
      if (state === 'transient') {
        const attempts = (oldAttempts.get(key) ?? 0) + 1;
        // Giving up is a completed run's call: a failed judge says nothing about the item.
        if (attempts >= RESEARCH_FEED_MAX_RETRIES && !judgeStepFailed) {
          givenUp.push(key);
          state = 'given_up';
        } else {
          nextRetries.push({ key, attempts });
        }
      }
      if (candidate.publishedAt) dated.push({ at: candidate.publishedAt.getTime(), state });
    }

    // Old retries survive only while the item is still in the feed and this run did not touch it.
    const keptRetries = (base?.retries ?? []).filter(
      retry => feedKeysInFeed.has(retry.key) && !feedStates.has(retry.key)
    );
    const retries = [...keptRetries, ...nextRetries];
    if (judgeStepFailed) return { ...base!, retries };

    // The floor never passes an item that still needs a run; a given-up item no longer does.
    const blockedAt = Math.min(
      Infinity,
      ...dated.filter(item => item.state === 'unreached' || item.state === 'transient').map(item => item.at)
    );
    let newest = base?.newestPublishedAt?.getTime() ?? null;
    for (const item of dated) {
      if (item.state === 'settled' && item.at < blockedAt && (newest === null || item.at > newest)) newest = item.at;
    }

    // Retaken items leave the old list: they are settled again below or are waiting in retries.
    const retaken = new Set(candidates.map(candidate => canonicalSourceKey(candidate.url)));
    const carried =
      (mode === 'same_feed' ? (base?.seenKeys ?? []).filter(key => !retaken.has(key)) : base?.seenKeys) ?? [];
    return {
      fingerprint,
      feedUrlKey: researchFeedUrlKey(levers.feedUrl),
      newestPublishedAt: newest === null ? null : new Date(newest),
      seenKeys: [...new Set([...carried, ...feedSkipped, ...settledKeys, ...givenUp])].slice(
        -RESEARCH_FEED_SEEN_KEYS_MAX
      ),
      retries,
    };
  };

  let candidates: ResearchCandidate[] = [];
  const settle = (stopReason: ResearchRunStopReason): ResearchRunResult => {
    const judgeStepFailed = totals.judgeFailed > 0 && scored === 0;
    const feedCursor = isFeed ? buildFeedCursor(candidates, judgeStepFailed) : undefined;
    return {
      totals,
      spentMicroUsd,
      stopReason,
      judgeStepFailed,
      judgeError,
      ...(isFeed ? { ...(feedCursor ? { feedCursor } : {}), feedBacklog } : {}),
    };
  };

  const autoAdmitRule: AutoAdmitRule = { isTrusted: url => trustedEntryForUrl(url, levers) };

  if (isFeed) {
    if (!levers.feedUrl) throw new FeedUnavailableError('This research config has no feed address');
    if (!ports.readFeed) throw new FeedUnavailableError('Reading feeds is not available in this deployment');
    const items = await ports.readFeed(levers.feedUrl);
    feedKeysInFeed = new Set(items.map(item => canonicalSourceKey(item.url)).filter((key): key is string => !!key));
    const selection = selectFeedCandidates(items, storedFeedCursor, levers, ports.now());
    candidates = selection.candidates;
    feedSkipped = selection.skipped;
    feedBacklog = selection.backlog;
  } else {
    candidates = await ports.search(levers.query, levers.maxResults, levers.recencyDays);
  }
  totals.searchHits = candidates.length;

  for (const [index, candidate] of candidates.entries()) {
    // Rule 1: the free filter, before anything is spent.
    const verdict = classifySource(candidate.url, levers);
    if (!isQueueableVerdict(verdict)) {
      totals.filteredBySource += 1;
      markFeedItem(candidate, 'settled');
      continue;
    }

    // Rule 2: the ceiling is a precondition of the next judgment, not a post-check on the last one.
    if (spentMicroUsd >= levers.costCeilingMicroUsd) return settle('cost_ceiling');
    if (outOfTime()) return settle('time_budget');

    const judgement = await ports.judge(candidate);
    spentMicroUsd += judgement.costMicroUsd;

    // A failed judgment and a low score are the same outcome for the CANDIDATE - both conservative,
    // nothing reaches a human unvouched-for - but they are opposite answers for the operator, so
    // they are counted apart. Folding them together is how a run reports a dead model as an empty web.
    if (judgement.outcome === 'failed') {
      totals.judgeFailed += 1;
      judgeError ??= judgement.error;
      markFeedItem(candidate, 'transient');
      // Only before the first score: once the judge has worked, a later failure is a blip, not an outage.
      if (scored === 0 && totals.judgeFailed >= JUDGE_BREAKER_FAILURES) {
        for (const unreached of candidates.slice(index + 1)) {
          if (!isQueueableVerdict(classifySource(unreached.url, levers))) totals.filteredBySource += 1;
          else totals.notJudged += 1;
        }
        return settle('judge_unavailable');
      }
      await ports.onProgress?.(spentMicroUsd, totals);
      continue;
    }
    scored += 1;
    if (judgement.relevance < levers.minRelevance) {
      totals.belowRelevance += 1;
      markFeedItem(candidate, 'settled');
      await ports.onProgress?.(spentMicroUsd, totals);
      continue;
    }

    // Rule 3: fetch only what cleared the judgment.
    const fetched = await ports.fetchSource(candidate.url);
    if (!fetched) {
      totals.fetchFailed += 1;
      markFeedItem(candidate, 'transient');
      await ports.onProgress?.(spentMicroUsd, totals);
      continue;
    }

    const outcome = await ports.propose({
      sourceUrl: candidate.url,
      // The page's own title beats the search hit's (the same words a reviewer sees on the page),
      // unless it is a placeholder (empty, domain label, or last path segment) and the hit has one.
      title:
        isPlaceholderTitle(fetched.title, fetched.finalUrl) && candidate.title.trim() ? candidate.title : fetched.title,
      text: fetched.text,
      proposedTags: levers.proposedTags,
      // Advisory display only. Recorded because a reviewer weighing an unfamiliar source has
      // nothing else to weigh; nothing in the system gates on it - see IDataLakeProposal.confidence.
      confidence: judgement.relevance,
      rationale: judgement.rationale,
      provenance: {
        producer: RESEARCH_RUN_PRODUCER,
        runId,
        query: levers.query,
        ...(isFeed && levers.feedUrl ? { feedUrl: levers.feedUrl } : {}),
        // When the producer RETRIEVED it, which is the fetch that just happened - not when the row
        // is written, and not when the run started.
        retrievedAt: ports.now(),
        // Admission is never decided by score: the tier comes from the source alone.
        sourceTier: verdict,
      },
    });

    switch (outcome.outcome) {
      case 'proposed': {
        totals.proposed += 1;
        // Only first-time proposals: a row with any prior disposition (declined, approved) goes to a human.
        const eligible =
          ports.autoAdmit !== undefined &&
          levers.autoAdmitTrusted &&
          verdict === 'trusted' &&
          outcome.proposal.priorDisposition == null &&
          totals.autoAdmitted < levers.maxAutoAdmits &&
          trustedEntryForUrl(candidate.url, levers) !== null &&
          trustedEntryForUrl(fetched.finalUrl, levers) !== null &&
          !outOfTime();
        if (eligible) {
          const result = await ports.autoAdmit!(outcome.proposal, autoAdmitRule);
          if (result === 'admitted') totals.autoAdmitted += 1;
          else totals.autoAdmitSkipped += 1;
        }
        break;
      }
      case 'duplicate_pending':
        totals.duplicatePending += 1;
        break;
      case 'already_in_lake':
        totals.alreadyInLake += 1;
        break;
      case 'suppressed_by_tombstone':
        totals.suppressedByTombstone += 1;
        break;
      case 'unusable_source':
        totals.unusableSource += 1;
        break;
    }
    // An outcome the switch above does not name stays unmarked, so the item is not-reached and
    // holds the cursor rather than being recorded as dealt with.
    if (outcome.outcome in SETTLED_PROPOSE_OUTCOMES) markFeedItem(candidate, 'settled');

    await ports.onProgress?.(spentMicroUsd, totals);

    // Rule 4: only a card that actually reached the reviewer counts against the limit. A dedup
    // outcome added nothing to their queue, so charging it would let a run over an already-covered
    // topic stop having proposed nothing.
    if (totals.proposed >= levers.maxProposals) return settle('proposal_limit');
  }

  return settle('exhausted');
}
