import type { ResearchRunLevers, ResearchRunStopReason, ResearchRunTotals } from '@bike4mind/common';
import { emptyResearchRunTotals, RESEARCH_RUN_PRODUCER } from '@bike4mind/common';
import type { ProposalCandidate, ProposalOutcome } from '../dataLakeService/proposeDataLakeContent';
import { classifySource } from './sourceFilter';

/**
 * The run loop (#1682): search -> filter by source -> judge -> fetch -> propose, once per candidate,
 * until the candidates run out or a lever stops it.
 *
 * PURE ORCHESTRATION. Every effect is a port, so the ordering rules below - which are the whole
 * value of this function - are testable without a network, a model or a database. Those rules:
 *
 *  1. The FREE filter runs first. Allow/deny drops a candidate before a judgment and before a fetch,
 *     so a narrow allow list costs nothing to enforce.
 *  2. The ceiling is checked BEFORE each judgment, never after. Checking after would always
 *     overspend by one call, and one call is the entire budget of a small ceiling.
 *  3. The fetch happens only after the judgment clears. Fetching first would be cheaper in latency
 *     and more expensive in bandwidth on exactly the candidates we are about to discard.
 *  4. The proposal limit is checked after each successful proposal, so a run that hits it has
 *     produced exactly `maxProposals` cards and not one more.
 *
 * It never writes a FabFile and never stamps a lake tag: the only write it can cause is a `pending`
 * proposal, and a human approving that is still what admits content.
 */

/** One normalized search hit. Structurally the search providers' `WebSearchProviderResult`. */
export interface ResearchCandidate {
  title: string;
  url: string;
  snippet: string;
}

/** What a fetch produced, honoring the queue's extraction contract. See `fetchSource` below. */
export interface FetchedSource {
  title: string;
  /**
   * The extracted text, or undefined when the door cannot produce text comparable with what the
   * INGESTION door would extract from the same URL. Undefined is a real answer, not a failure: the
   * candidate is still proposed, on source-keyed dedup alone.
   */
  text?: string;
}

export interface ResearchRunPorts {
  /** Ask the search provider for up to `maxResults` hits, honoring the recency lever. */
  search(query: string, maxResults: number, recencyDays?: number): Promise<ResearchCandidate[]>;
  /**
   * Score one candidate 0..1 and report what the judgment cost. Null when the model could not be
   * reached at all - counted as below-relevance, so a broken model proposes nothing rather than
   * everything.
   */
  judge(candidate: ResearchCandidate): Promise<{ relevance: number; rationale?: string; costMicroUsd: number } | null>;
  /**
   * Retrieve the page. MUST use the same extractor the ingestion door uses
   * (`fetchAndParseURL` -> the chunker's text branch) or both of the queue's text-hash comparisons
   * silently miss - see `ProposalCandidate.text`. Null when the page could not be fetched.
   */
  fetchSource(url: string): Promise<FetchedSource | null>;
  /** Hand the candidate to `proposeDataLakeContent`. The ONLY write this loop can cause. */
  propose(candidate: ProposalCandidate): Promise<ProposalOutcome>;
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
}

/**
 * Stop this far short of the deadline. One candidate is a judgment plus a fetch plus a proposal
 * write, and the fetch alone can take the URL fetcher's full timeout, so the reserve has to cover a
 * whole iteration rather than just the write at the end of it.
 */
const TIME_BUDGET_RESERVE_MS = 90_000;

export async function executeResearchRun(
  levers: ResearchRunLevers,
  runId: string,
  ports: ResearchRunPorts
): Promise<ResearchRunResult> {
  const totals = emptyResearchRunTotals();
  let spentMicroUsd = 0;

  const outOfTime = (): boolean =>
    ports.remainingTimeMs !== undefined && ports.remainingTimeMs() <= TIME_BUDGET_RESERVE_MS;

  const settle = (stopReason: ResearchRunStopReason): ResearchRunResult => ({
    totals,
    spentMicroUsd,
    stopReason,
  });

  const candidates = await ports.search(levers.query, levers.maxResults, levers.recencyDays);
  totals.searchHits = candidates.length;

  for (const candidate of candidates) {
    // Rule 1: the free filter, before anything is spent.
    if (classifySource(candidate.url, levers) !== 'allowed') {
      totals.filteredBySource += 1;
      continue;
    }

    // Rule 2: the ceiling is a precondition of the next judgment, not a post-check on the last one.
    if (spentMicroUsd >= levers.costCeilingMicroUsd) return settle('cost_ceiling');
    if (outOfTime()) return settle('time_budget');

    const judgement = await ports.judge(candidate);
    spentMicroUsd += judgement?.costMicroUsd ?? 0;

    // A null judgment (the model was unreachable) and a low score are the same outcome for the
    // candidate, and both are conservative: nothing reaches a human unvouched-for.
    if (!judgement || judgement.relevance < levers.minRelevance) {
      totals.belowRelevance += 1;
      await ports.onProgress?.(spentMicroUsd, totals);
      continue;
    }

    // Rule 3: fetch only what cleared the judgment.
    const fetched = await ports.fetchSource(candidate.url);
    if (!fetched) {
      totals.fetchFailed += 1;
      await ports.onProgress?.(spentMicroUsd, totals);
      continue;
    }

    const outcome = await ports.propose({
      sourceUrl: candidate.url,
      // The page's own title beats the search hit's: the hit's is the provider's rendering of it,
      // and a reviewer opening the link should see the same words on both sides.
      title: fetched.title || candidate.title,
      text: fetched.text,
      proposedTags: levers.proposedTags,
      // Advisory display only. Recorded because a reviewer weighing an unfamiliar source has
      // nothing else to weigh; nothing in the system gates on it - see IDataLakeProposal.confidence.
      confidence: judgement.relevance,
      provenance: {
        producer: RESEARCH_RUN_PRODUCER,
        runId,
        query: levers.query,
        // When the producer RETRIEVED it, which is the fetch that just happened - not when the row
        // is written, and not when the run started.
        retrievedAt: ports.now(),
      },
    });

    switch (outcome.outcome) {
      case 'proposed':
        totals.proposed += 1;
        break;
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

    await ports.onProgress?.(spentMicroUsd, totals);

    // Rule 4: only a card that actually reached the reviewer counts against the limit. A dedup
    // outcome added nothing to their queue, so charging it would let a run over an already-covered
    // topic stop having proposed nothing.
    if (totals.proposed >= levers.maxProposals) return settle('proposal_limit');
  }

  return settle('exhausted');
}
