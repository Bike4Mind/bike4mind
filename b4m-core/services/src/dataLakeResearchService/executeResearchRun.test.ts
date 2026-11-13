import { describe, it, expect, vi } from 'vitest';
import type { LegacyResearchRunLevers, ResearchFeedCursor } from '@bike4mind/common';
import {
  researchFeedFingerprint,
  RESEARCH_FEED_FUTURE_SKEW_MS,
  RESEARCH_FEED_MAX_RETRIES,
  RESEARCH_FEED_SEEN_KEYS_MAX,
  RESEARCH_RUN_PRODUCER,
  upgradeLegacyResearchLevers,
} from '@bike4mind/common';
import { canonicalSourceKey } from '../dataLakeService/canonicalSourceKey';
import type { ProposalCandidate, ProposalOutcome } from '../dataLakeService/proposeDataLakeContent';
import {
  executeResearchRun,
  FeedUnavailableError,
  SETTLED_PROPOSE_OUTCOMES,
  type ResearchCandidate,
  type ResearchRunPorts,
  type ResearchRunResult,
} from './executeResearchRun';

const NOW = new Date('2026-03-01T12:00:00.000Z');

const levers = (overrides: Partial<LegacyResearchRunLevers> = {}): LegacyResearchRunLevers => ({
  query: 'coastal erosion',
  maxResults: 10,
  maxProposals: 5,
  trustedDomains: [],
  reviewDomains: [],
  unlistedSources: 'review',
  blockedDomains: [],
  minRelevance: 0.6,
  costCeilingMicroUsd: 10_000,
  proposedTags: ['research'],
  ...overrides,
});

const hit = (n: number, host = 'example.com'): ResearchCandidate => ({
  title: `Result ${n}`,
  url: `https://${host}/${n}`,
  snippet: `Snippet ${n}`,
});

const proposed = (): ProposalOutcome => ({ outcome: 'proposed', proposal: { id: 'p1' } }) as unknown as ProposalOutcome;

interface PortOverrides extends Partial<ResearchRunPorts> {
  candidates?: ResearchCandidate[];
}

/** Ports where everything succeeds, so a test only states the one behaviour it is about. */
const makePorts = ({ candidates = [hit(1)], ...overrides }: PortOverrides = {}) => {
  const calls = { judged: [] as string[], fetched: [] as string[], proposals: [] as ProposalCandidate[] };
  const ports: ResearchRunPorts = {
    search: vi.fn(async () => candidates),
    judge: vi.fn(async (candidate: ResearchCandidate) => {
      calls.judged.push(candidate.url);
      return { outcome: 'judged', relevance: 1, costMicroUsd: 1_000 };
    }),
    fetchSource: vi.fn(async (url: string) => {
      calls.fetched.push(url);
      return { title: 'Fetched title', finalUrl: url, text: 'body text' };
    }),
    propose: vi.fn(async (candidate: ProposalCandidate) => {
      calls.proposals.push(candidate);
      return proposed();
    }),
    now: () => NOW,
    ...overrides,
  };
  return { ports, calls };
};

describe('executeResearchRun', () => {
  it('passes the search levers through to the provider', async () => {
    const { ports } = makePorts();
    await executeResearchRun(levers({ maxResults: 7, recencyDays: 30 }), 'run-1', ports);
    expect(ports.search).toHaveBeenCalledWith('coastal erosion', 7, 30);
  });

  it('proposes a cleared candidate with its run provenance, advisory confidence and rationale', async () => {
    const { ports, calls } = makePorts();
    (ports.judge as ReturnType<typeof vi.fn>).mockResolvedValue({
      outcome: 'judged',
      relevance: 0.82,
      rationale: 'directly about coastal erosion',
      costMicroUsd: 500,
    });

    const result = await executeResearchRun(levers(), 'run-1', ports);

    expect(calls.proposals).toHaveLength(1);
    expect(calls.proposals[0]).toMatchObject({
      sourceUrl: 'https://example.com/1',
      // The page's own title wins over the search hit's rendering of it.
      title: 'Fetched title',
      text: 'body text',
      proposedTags: ['research'],
      confidence: 0.82,
      rationale: 'directly about coastal erosion',
      provenance: { producer: RESEARCH_RUN_PRODUCER, runId: 'run-1', query: 'coastal erosion', retrievedAt: NOW },
    });
    expect(result.totals.proposed).toBe(1);
    expect(result.spentMicroUsd).toBe(500);
    expect(result.stopReason).toBe('exhausted');
  });

  it('falls back to the search hit title when the fetch yields none', async () => {
    const { ports, calls } = makePorts();
    (ports.fetchSource as ReturnType<typeof vi.fn>).mockResolvedValue({
      title: '',
      finalUrl: 'https://example.com/1',
      text: 'body',
    });
    await executeResearchRun(levers(), 'run-1', ports);
    expect(calls.proposals[0].title).toBe('Result 1');
  });

  it('keeps the search hit title when the fetched title is only the url last path segment', async () => {
    const { ports, calls } = makePorts({
      candidates: [
        { title: 'Job shop scheduling with deep RL', url: 'https://arxiv.org/pdf/1909.08247', snippet: 's' },
      ],
    });
    (ports.fetchSource as ReturnType<typeof vi.fn>).mockResolvedValue({
      title: '1909.08247',
      finalUrl: 'https://arxiv.org/pdf/1909.08247',
      text: 'body',
    });
    await executeResearchRun(levers(), 'run-1', ports);
    expect(calls.proposals[0].title).toBe('Job shop scheduling with deep RL');
  });

  it('keeps the fetched title when it is a placeholder but the hit title is blank', async () => {
    const { ports, calls } = makePorts({
      candidates: [{ title: '   ', url: 'https://arxiv.org/pdf/1909.08247', snippet: 's' }],
    });
    (ports.fetchSource as ReturnType<typeof vi.fn>).mockResolvedValue({
      title: '1909.08247',
      finalUrl: 'https://arxiv.org/pdf/1909.08247',
      text: 'body',
    });
    await executeResearchRun(levers(), 'run-1', ports);
    expect(calls.proposals[0].title).toBe('1909.08247');
  });

  it('checks the placeholder against the redirected final url, not the search hit url', async () => {
    const { ports, calls } = makePorts({
      candidates: [
        { title: 'Real paper title', url: 'https://ieeexplore.ieee.org/iel4/9/6845/00277252.pdf', snippet: 's' },
      ],
    });
    (ports.fetchSource as ReturnType<typeof vi.fn>).mockResolvedValue({
      title: ';jsessionid=ABC123',
      finalUrl: 'https://ieeexplore.ieee.org/document/277252/;jsessionid=ABC123',
      text: 'body',
    });
    await executeResearchRun(levers(), 'run-1', ports);
    expect(calls.proposals[0].title).toBe('Real paper title');
    expect(calls.proposals[0].sourceUrl).toBe('https://ieeexplore.ieee.org/iel4/9/6845/00277252.pdf');
  });

  // Rule 1: the free filter runs first, so a narrow allow list costs nothing to enforce.
  describe('rule 1 - the source filter is free and runs first', () => {
    it('drops a filtered candidate without judging or fetching it', async () => {
      const { ports, calls } = makePorts({ candidates: [hit(1, 'spam.net'), hit(2, 'example.com')] });

      const result = await executeResearchRun(levers({ blockedDomains: ['spam.net'] }), 'run-1', ports);

      expect(calls.judged).toEqual(['https://example.com/2']);
      expect(calls.fetched).toEqual(['https://example.com/2']);
      expect(result.totals.filteredBySource).toBe(1);
      expect(result.totals.proposed).toBe(1);
    });

    it('drops everything outside the review list when other sites are ignored', async () => {
      const { ports, calls } = makePorts({ candidates: [hit(1, 'other.com'), hit(2, 'docs.example.com')] });

      const result = await executeResearchRun(
        levers({ reviewDomains: ['example.com'], unlistedSources: 'drop' }),
        'run-1',
        ports
      );

      expect(calls.judged).toEqual(['https://docs.example.com/2']);
      expect(result.totals.filteredBySource).toBe(1);
    });

    it('upgrades a legacy-shaped snapshot, so a stored allow list still restricts the run', async () => {
      const { ports, calls } = makePorts({ candidates: [hit(1, 'other.com'), hit(2, 'docs.example.com')] });
      const legacy: LegacyResearchRunLevers = { ...levers({ allowedDomains: ['example.com'] }) };
      delete legacy.trustedDomains;
      delete legacy.reviewDomains;
      delete legacy.unlistedSources;

      const result = await executeResearchRun(legacy, 'run-1', ports);

      expect(calls.judged).toEqual(['https://docs.example.com/2']);
      expect(result.totals.filteredBySource).toBe(1);
    });

    it('passes the source tier of each proposed candidate to propose', async () => {
      const { ports, calls } = makePorts({ candidates: [hit(1, 'trusted.example'), hit(2, 'other.example')] });

      await executeResearchRun(levers({ trustedDomains: ['trusted.example'] }), 'run-1', ports);

      expect(calls.proposals.map(c => c.provenance.sourceTier)).toEqual(['trusted', 'review']);
    });
  });

  // Rule 2: the ceiling is a precondition of the NEXT judgment, never a post-check on the last.
  describe('rule 2 - the cost ceiling', () => {
    it('stops before the judgment that would exceed it', async () => {
      const { ports } = makePorts({ candidates: [hit(1), hit(2), hit(3)] });
      (ports.judge as ReturnType<typeof vi.fn>).mockResolvedValue({
        outcome: 'judged',
        relevance: 0.1,
        costMicroUsd: 600,
      });

      const result = await executeResearchRun(levers({ costCeilingMicroUsd: 1_000 }), 'run-1', ports);

      // Two judgments (600, then 1200 >= 1000 stops the third), never a third. Counted off the spy
      // rather than `calls.judged`, which the mockResolvedValue above replaced.
      expect(ports.judge).toHaveBeenCalledTimes(2);
      expect(result.spentMicroUsd).toBe(1_200);
      expect(result.stopReason).toBe('cost_ceiling');
    });

    it('proposes nothing when the model fails, and says so rather than blaming the web', async () => {
      const { ports } = makePorts({ candidates: [hit(1), hit(2)] });
      (ports.judge as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ outcome: 'failed', error: 'model access denied', costMicroUsd: 30 })
        .mockResolvedValueOnce({ outcome: 'failed', error: 'a later error', costMicroUsd: 0 });

      const result = await executeResearchRun(levers(), 'run-1', ports);

      // Conservative for the candidate, but counted apart from a genuine low score, because "20 hits,
      // 20 below relevance" would send a manager off to retune a query that was never the problem.
      expect(result.totals.judgeFailed).toBe(2);
      expect(result.totals.belowRelevance).toBe(0);
      expect(result.totals.proposed).toBe(0);
      // Still charged: a failed call that burned tokens moves the ceiling.
      expect(result.spentMicroUsd).toBe(30);
      expect(result).toMatchObject({ judgeStepFailed: true, judgeError: 'model access denied' });
    });

    it('is not a failed judge step when at least one candidate was scored', async () => {
      const { ports } = makePorts({ candidates: [hit(1), hit(2)] });
      (ports.judge as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ outcome: 'failed', error: 'rate limited', costMicroUsd: 0 })
        .mockResolvedValueOnce({ outcome: 'judged', relevance: 0.1, costMicroUsd: 10 });

      const result = await executeResearchRun(levers(), 'run-1', ports);

      expect(result.totals).toMatchObject({ judgeFailed: 1, belowRelevance: 1 });
      expect(result).toMatchObject({ judgeStepFailed: false, judgeError: 'rate limited' });
    });

    it('is not a failed judge step when nothing was judged at all', async () => {
      const { ports } = makePorts({ candidates: [] });
      const result = await executeResearchRun(levers(), 'run-1', ports);
      expect(result.judgeStepFailed).toBe(false);
      expect(result.judgeError).toBeUndefined();
    });
  });

  describe('judge circuit breaker', () => {
    const failing = { outcome: 'failed', error: 'model access denied', costMicroUsd: 0 } as const;
    const bucketSum = ({ searchHits: _hits, ...buckets }: Record<string, number>): number =>
      Object.values(buckets).reduce((sum, n) => sum + n, 0);

    it('stops after three failures with nothing scored, and counts the rest as not judged', async () => {
      const candidates = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n =>
        hit(n, [2, 4, 7].includes(n) ? 'spam.net' : 'example.com')
      );
      const { ports, calls } = makePorts({ candidates, judge: vi.fn(async () => failing) });

      const result = await executeResearchRun(levers({ blockedDomains: ['spam.net'] }), 'run-1', ports);

      expect(ports.judge).toHaveBeenCalledTimes(3);
      expect(calls.fetched).toEqual([]);
      expect(result.stopReason).toBe('judge_unavailable');
      expect(result).toMatchObject({ judgeStepFailed: true, judgeError: 'model access denied' });
      expect(result.totals).toMatchObject({ searchHits: 10, filteredBySource: 3, judgeFailed: 3, notJudged: 4 });
      expect(bucketSum({ ...result.totals })).toBe(result.totals.searchHits);
    });

    it('leaves nothing uncounted when the breaker trips on the last candidate', async () => {
      const { ports } = makePorts({ candidates: [hit(1), hit(2), hit(3)], judge: vi.fn(async () => failing) });

      const result = await executeResearchRun(levers(), 'run-1', ports);

      expect(result.stopReason).toBe('judge_unavailable');
      expect(result.totals).toMatchObject({ judgeFailed: 3, notJudged: 0 });
    });

    it('does not trip on a judge that fails once and then recovers', async () => {
      const { ports } = makePorts({ candidates: [hit(1), hit(2), hit(3), hit(4)] });
      (ports.judge as ReturnType<typeof vi.fn>).mockResolvedValueOnce(failing);

      const result = await executeResearchRun(levers(), 'run-1', ports);

      expect(ports.judge).toHaveBeenCalledTimes(4);
      expect(result.stopReason).toBe('exhausted');
      expect(result.totals).toMatchObject({ judgeFailed: 1, proposed: 3, notJudged: 0 });
    });

    it('keeps going through failures once the judge has scored something', async () => {
      const { ports } = makePorts({ candidates: [hit(1), hit(2), hit(3), hit(4), hit(5)] });
      (ports.judge as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ outcome: 'judged', relevance: 0.1, costMicroUsd: 10 })
        .mockResolvedValue(failing);

      const result = await executeResearchRun(levers(), 'run-1', ports);

      expect(ports.judge).toHaveBeenCalledTimes(5);
      expect(result.stopReason).toBe('exhausted');
      expect(result).toMatchObject({ judgeStepFailed: false });
      expect(result.totals).toMatchObject({ belowRelevance: 1, judgeFailed: 4, notJudged: 0 });
    });
  });

  // Rule 3: fetch only what cleared the judgment.
  it('never fetches a candidate below the relevance floor', async () => {
    const { ports, calls } = makePorts({ candidates: [hit(1), hit(2)] });
    (ports.judge as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ outcome: 'judged', relevance: 0.2, costMicroUsd: 10 })
      .mockResolvedValueOnce({ outcome: 'judged', relevance: 0.9, costMicroUsd: 10 });

    const result = await executeResearchRun(levers({ minRelevance: 0.6 }), 'run-1', ports);

    expect(calls.fetched).toEqual(['https://example.com/2']);
    expect(result.totals.belowRelevance).toBe(1);
    expect(result.totals.proposed).toBe(1);
  });

  it('counts a failed fetch and moves on', async () => {
    const { ports, calls } = makePorts({ candidates: [hit(1), hit(2)] });
    (ports.fetchSource as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ title: 't', finalUrl: 'https://example.com/2', text: 'x' });

    const result = await executeResearchRun(levers(), 'run-1', ports);

    expect(result.totals.fetchFailed).toBe(1);
    expect(calls.proposals).toHaveLength(1);
  });

  // Rule 4: only a card that actually reached a reviewer counts against the limit.
  describe('rule 4 - the proposal limit', () => {
    it('stops at exactly maxProposals', async () => {
      const { ports, calls } = makePorts({ candidates: [hit(1), hit(2), hit(3), hit(4)] });

      const result = await executeResearchRun(levers({ maxProposals: 2 }), 'run-1', ports);

      expect(calls.proposals).toHaveLength(2);
      expect(result.totals.proposed).toBe(2);
      expect(result.stopReason).toBe('proposal_limit');
    });

    it('does not charge a dedup outcome against the limit', async () => {
      const { ports } = makePorts({ candidates: [hit(1), hit(2), hit(3)] });
      (ports.propose as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ outcome: 'duplicate_pending', proposalId: 'x' })
        .mockResolvedValueOnce({ outcome: 'already_in_lake', reason: 'lake_member' })
        .mockResolvedValueOnce(proposed());

      const result = await executeResearchRun(levers({ maxProposals: 1 }), 'run-1', ports);

      expect(result.totals.duplicatePending).toBe(1);
      expect(result.totals.alreadyInLake).toBe(1);
      expect(result.totals.proposed).toBe(1);
      expect(result.stopReason).toBe('proposal_limit');
    });

    it('records every dedup outcome the queue can answer with', async () => {
      const { ports } = makePorts({ candidates: [hit(1), hit(2)] });
      (ports.propose as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ outcome: 'suppressed_by_tombstone', proposalId: 'x' })
        .mockResolvedValueOnce({ outcome: 'unusable_source', reason: 'not_http_url' });

      const result = await executeResearchRun(levers(), 'run-1', ports);

      expect(result.totals.suppressedByTombstone).toBe(1);
      expect(result.totals.unusableSource).toBe(1);
      expect(result.stopReason).toBe('exhausted');
    });
  });

  describe('time budget', () => {
    it('stops cleanly rather than being killed mid-candidate', async () => {
      const { ports, calls } = makePorts({
        candidates: [hit(1), hit(2)],
        // Below the reserve from the start: nothing should be judged at all.
        remainingTimeMs: () => 1_000,
      });

      const result = await executeResearchRun(levers(), 'run-1', ports);

      expect(calls.judged).toEqual([]);
      expect(result.stopReason).toBe('time_budget');
    });

    it('runs normally with plenty of time left', async () => {
      const { ports, calls } = makePorts({ candidates: [hit(1)], remainingTimeMs: () => 600_000 });
      const result = await executeResearchRun(levers(), 'run-1', ports);
      expect(calls.judged).toHaveLength(1);
      expect(result.stopReason).toBe('exhausted');
    });
  });

  it('reports progress after every settled candidate, not only the proposed ones', async () => {
    const onProgress = vi.fn(async () => {});
    const { ports } = makePorts({ candidates: [hit(1), hit(2)], onProgress });
    (ports.judge as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ outcome: 'judged', relevance: 0.1, costMicroUsd: 10 })
      .mockResolvedValueOnce({ outcome: 'judged', relevance: 0.9, costMicroUsd: 10 });

    await executeResearchRun(levers(), 'run-1', ports);

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(20, expect.objectContaining({ proposed: 1, belowRelevance: 1 }));
  });

  it('settles as exhausted with zero totals when the search finds nothing', async () => {
    const { ports } = makePorts({ candidates: [] });
    const result = await executeResearchRun(levers(), 'run-1', ports);
    expect(result).toMatchObject({ spentMicroUsd: 0, stopReason: 'exhausted' });
    expect(result.totals.searchHits).toBe(0);
  });

  describe('auto-admit', () => {
    const autoLevers = (overrides: Partial<LegacyResearchRunLevers> = {}) =>
      levers({ trustedDomains: ['example.com'], autoAdmitTrusted: true, maxAutoAdmits: 2, ...overrides });
    const proposedWith = (priorDisposition?: 'declined' | 'approved' | null): ProposalOutcome =>
      ({ outcome: 'proposed', proposal: { id: 'p1', priorDisposition } }) as unknown as ProposalOutcome;
    const autoPorts = (overrides: PortOverrides = {}) => {
      const autoAdmit = vi.fn(async () => 'admitted' as const);
      return { autoAdmit, ...makePorts({ autoAdmit, propose: async () => proposedWith(null), ...overrides }) };
    };

    it('admits nothing when the opt-in is off', async () => {
      const { ports, autoAdmit } = autoPorts();
      const result = await executeResearchRun(autoLevers({ autoAdmitTrusted: false }), 'run-1', ports);
      expect(autoAdmit).not.toHaveBeenCalled();
      expect(result.totals.autoAdmitted).toBe(0);
    });

    it('admits nothing when the caller supplies no port', async () => {
      const { ports } = makePorts({ propose: async () => proposedWith(null) });
      const result = await executeResearchRun(autoLevers(), 'run-1', ports);
      expect(result.totals.proposed).toBe(1);
      expect(result.totals.autoAdmitted).toBe(0);
    });

    it('admits trusted hits up to the cap, then leaves the rest queued', async () => {
      const { ports, autoAdmit } = autoPorts({ candidates: [hit(1), hit(2), hit(3)] });
      const result = await executeResearchRun(autoLevers(), 'run-1', ports);
      expect(autoAdmit).toHaveBeenCalledTimes(2);
      expect(result.totals).toMatchObject({ proposed: 3, autoAdmitted: 2, autoAdmitSkipped: 0 });
    });

    it('never admits a review-tier hit', async () => {
      const { ports, autoAdmit } = autoPorts({ candidates: [hit(1, 'other.org')] });
      const result = await executeResearchRun(autoLevers(), 'run-1', ports);
      expect(autoAdmit).not.toHaveBeenCalled();
      expect(result.totals.proposed).toBe(1);
    });

    it.each(['declined', 'approved'] as const)('queues a re-proposed %s source', async prior => {
      const { ports, autoAdmit } = autoPorts({ propose: async () => proposedWith(prior) });
      await executeResearchRun(autoLevers(), 'run-1', ports);
      expect(autoAdmit).not.toHaveBeenCalled();
    });

    it('never calls the port for a tombstoned source', async () => {
      const { ports, autoAdmit } = autoPorts({
        propose: async () => ({ outcome: 'suppressed_by_tombstone', proposalId: 'p0' }),
      });
      await executeResearchRun(autoLevers(), 'run-1', ports);
      expect(autoAdmit).not.toHaveBeenCalled();
    });

    it('queues a hit whose final URL is not trusted', async () => {
      const { ports, autoAdmit } = autoPorts({
        fetchSource: async () => ({ title: 't', finalUrl: 'https://elsewhere.net/x', text: 'b' }),
      });
      await executeResearchRun(autoLevers(), 'run-1', ports);
      expect(autoAdmit).not.toHaveBeenCalled();
    });

    it('does not let an entry above the registrable domain cover a host under a shared suffix', async () => {
      const { ports, autoAdmit } = autoPorts({ candidates: [hit(1, 'evil.s3.amazonaws.com')] });
      await executeResearchRun(autoLevers({ trustedDomains: ['amazonaws.com'] }), 'run-1', ports);
      expect(autoAdmit).not.toHaveBeenCalled();
    });

    it('queues when the time reserve is spent after the fetch', async () => {
      const remaining = vi.fn().mockReturnValueOnce(1_000_000).mockReturnValue(1_000);
      const { ports, autoAdmit } = autoPorts({ remainingTimeMs: remaining });
      await executeResearchRun(autoLevers(), 'run-1', ports);
      expect(autoAdmit).not.toHaveBeenCalled();
    });

    it('counts a left_pending result as a skip and still proposes', async () => {
      const { ports } = autoPorts({ autoAdmit: async () => 'left_pending' });
      const result = await executeResearchRun(autoLevers(), 'run-1', ports);
      expect(result.totals).toMatchObject({ proposed: 1, autoAdmitted: 0, autoAdmitSkipped: 1 });
    });

    it('hands the port a predicate keyed to the trusted list', async () => {
      const { ports, autoAdmit } = autoPorts();
      await executeResearchRun(autoLevers(), 'run-1', ports);
      const rule = (autoAdmit.mock.calls[0] as unknown as [unknown, { isTrusted(u: string): string | null }])[1];
      expect(rule.isTrusted('https://docs.example.com/a')).toBe('example.com');
      expect(rule.isTrusted('https://other.org/a')).toBeNull();
    });

    it('counts auto-admits toward the proposal limit', async () => {
      const { ports } = autoPorts({ candidates: [hit(1), hit(2), hit(3)] });
      const result = await executeResearchRun(autoLevers({ maxProposals: 2 }), 'run-1', ports);
      expect(result.stopReason).toBe('proposal_limit');
      expect(result.totals.proposed).toBe(2);
    });
  });
});

describe('executeResearchRun - feed source', () => {
  const FEED_URL = 'https://feeds.example.org/f.xml';
  const feedLevers = (overrides: Partial<LegacyResearchRunLevers> = {}) =>
    levers({ source: 'feed', feedUrl: FEED_URL, maxResults: 20, ...overrides });
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
  const dated = (n: number, ageDays: number): ResearchCandidate => ({ ...hit(n), publishedAt: daysAgo(ageDays) });
  const keyOf = (n: number) => canonicalSourceKey(hit(n).url)!;

  const feedPorts = (items: ResearchCandidate[], overrides: Partial<ResearchRunPorts> = {}) => {
    const made = makePorts(overrides);
    made.ports.readFeed = vi.fn(async () => items);
    return made;
  };
  const cursorFor = (l: LegacyResearchRunLevers, patch: Partial<ResearchFeedCursor> = {}): ResearchFeedCursor => ({
    fingerprint: researchFeedFingerprint(upgradeLegacyResearchLevers(l)),
    newestPublishedAt: null,
    seenKeys: [],
    retries: [],
    ...patch,
  });
  const failJudge = (urls: string[]) => (candidate: ResearchCandidate) =>
    urls.includes(candidate.url)
      ? Promise.resolve({ outcome: 'failed' as const, error: 'boom', costMicroUsd: 0 })
      : Promise.resolve({ outcome: 'judged' as const, relevance: 1, costMicroUsd: 1_000 });

  it('reads the feed instead of searching, counts selected items and stamps the feed url in provenance', async () => {
    const { ports, calls } = feedPorts([dated(1, 2), dated(2, 1)]);
    const l = feedLevers();
    const result = await executeResearchRun(l, 'run-1', ports);

    expect(ports.search).not.toHaveBeenCalled();
    expect(ports.readFeed).toHaveBeenCalledWith(FEED_URL);
    expect(result.totals.searchHits).toBe(2);
    expect(calls.proposals).toHaveLength(2);
    expect(calls.proposals[0].provenance).toMatchObject({ query: 'coastal erosion', feedUrl: FEED_URL });
    expect(result.feedCursor?.fingerprint).toBe(researchFeedFingerprint(upgradeLegacyResearchLevers(l)));
  });

  it('applies source tiers and auto-admit to feed items', async () => {
    const autoAdmit = vi.fn(async () => 'admitted' as const);
    const { ports } = feedPorts([hit(1, 'trusted.example'), hit(2, 'blocked.example')], { autoAdmit });
    const result = await executeResearchRun(
      feedLevers({ trustedDomains: ['trusted.example'], blockedDomains: ['blocked.example'], autoAdmitTrusted: true }),
      'run-1',
      ports
    );
    expect(result.totals).toMatchObject({ proposed: 1, autoAdmitted: 1, filteredBySource: 1 });
    expect(autoAdmit).toHaveBeenCalledTimes(1);
  });

  it('returns no cursor or backlog for a search run', async () => {
    const { ports } = makePorts();
    const result = await executeResearchRun(levers(), 'run-1', ports);
    expect(result.feedCursor).toBeUndefined();
    expect(result.feedBacklog).toBeUndefined();
  });

  it('reports the selection backlog beside the totals', async () => {
    const l = feedLevers({ maxResults: 1 });
    const { ports } = feedPorts([dated(1, 3), dated(2, 2), dated(3, 1)]);
    const result = await executeResearchRun(l, 'run-1', ports, cursorFor(l));
    expect(result.feedBacklog).toBe(2);
    expect(result.totals.searchHits).toBe(1);
  });

  it('throws FeedUnavailableError for a feed run with no readFeed port or no feed url, and never searches', async () => {
    const { ports } = makePorts();
    await expect(executeResearchRun(feedLevers(), 'run-1', ports)).rejects.toBeInstanceOf(FeedUnavailableError);
    const withPort = feedPorts([]);
    await expect(executeResearchRun(feedLevers({ feedUrl: null }), 'run-1', withPort.ports)).rejects.toBeInstanceOf(
      FeedUnavailableError
    );
    expect(ports.search).not.toHaveBeenCalled();
  });

  it('lets a FeedUnavailableError from the port reach the caller', async () => {
    const { ports } = feedPorts([]);
    ports.readFeed = vi.fn(async () => {
      throw new FeedUnavailableError('This feed is larger than 10 MB');
    });
    await expect(executeResearchRun(feedLevers(), 'run-1', ports)).rejects.toThrow('This feed is larger than 10 MB');
  });

  describe('cursor', () => {
    it('keeps skipped keys ahead of settled keys, in processing order', async () => {
      const l = feedLevers({ maxResults: 2 });
      const { ports } = feedPorts([dated(1, 1), dated(2, 2), dated(3, 3), dated(4, 4)]);
      const result = await executeResearchRun(l, 'run-1', ports);
      expect(result.feedCursor?.seenKeys).toEqual([keyOf(4), keyOf(3), keyOf(2), keyOf(1)]);
      expect(result.feedBacklog).toBe(0);
    });

    it('puts old keys first and trims from the front at the cap', async () => {
      const l = feedLevers();
      const old = Array.from({ length: RESEARCH_FEED_SEEN_KEYS_MAX }, (_, i) => `old${i}`);
      const { ports } = feedPorts([dated(1, 1)]);
      const result = await executeResearchRun(l, 'run-1', ports, cursorFor(l, { seenKeys: old }));
      const keys = result.feedCursor!.seenKeys;
      expect(keys).toHaveLength(RESEARCH_FEED_SEEN_KEYS_MAX);
      expect(keys[0]).toBe('old1');
      expect(keys.at(-1)).toBe(keyOf(1));
    });

    it('ignores a stored cursor written under different levers', async () => {
      const l = feedLevers();
      const stale = { ...cursorFor(l, { seenKeys: [keyOf(1)] }), fingerprint: 'different' };
      const { ports, calls } = feedPorts([dated(1, 1)]);
      const result = await executeResearchRun(l, 'run-1', ports, stale);
      expect(calls.judged).toEqual([hit(1).url]);
      expect(result.feedCursor?.seenKeys).toEqual([keyOf(1)]);
    });

    it('moves the floor to the newest settled item when everything settled', async () => {
      const l = feedLevers();
      const { ports } = feedPorts([dated(1, 3), dated(2, 1)]);
      const result = await executeResearchRun(l, 'run-1', ports);
      expect(result.feedCursor?.newestPublishedAt).toEqual(daysAgo(1));
    });

    it('never moves the floor past now plus the skew for a future-dated item', async () => {
      const l = feedLevers();
      const future: ResearchCandidate = { ...hit(1), publishedAt: new Date('2035-01-01T00:00:00Z') };
      const { ports } = feedPorts([future]);
      const result = await executeResearchRun(l, 'run-1', ports);
      expect(result.feedCursor!.newestPublishedAt!.getTime()).toBeLessThanOrEqual(
        NOW.getTime() + RESEARCH_FEED_FUTURE_SKEW_MS
      );
    });

    it('keeps a floor from the old cursor when nothing newer settled', async () => {
      const l = feedLevers();
      const { ports } = feedPorts([dated(1, 10)]);
      const result = await executeResearchRun(l, 'run-1', ports, cursorFor(l, { newestPublishedAt: daysAgo(2) }));
      expect(result.feedCursor?.newestPublishedAt).toEqual(daysAgo(2));
    });
  });

  describe('transient failures', () => {
    it.each([
      ['a judge failure before any score', [1], 'judge'],
      ['a judge failure after the first score', [2], 'judge'],
      ['a fetch failure', [2], 'fetch'],
    ])('%s keeps the item out of seenKeys, queues a retry and holds the floor below it', async (_n, failing, kind) => {
      const l = feedLevers();
      // Oldest first: item 1 is 5 days old, 2 is 3 days old, 3 is 1 day old.
      const { ports } = feedPorts([dated(1, 5), dated(2, 3), dated(3, 1)]);
      if (kind === 'judge') ports.judge = vi.fn(failJudge(failing.map(n => hit(n).url)));
      else
        ports.fetchSource = vi.fn(async url => (url === hit(2).url ? null : { title: 't', finalUrl: url, text: 'x' }));

      const result = await executeResearchRun(l, 'run-1', ports);
      const cursor = result.feedCursor!;
      const failedKey = keyOf(failing[0]);
      expect(cursor.seenKeys).not.toContain(failedKey);
      expect(cursor.retries).toEqual([{ key: failedKey, attempts: 1 }]);
      // Floor stops strictly below the failed item: only items older than it can move it.
      const settledOlder = failing[0] === 1 ? null : daysAgo(5);
      expect(cursor.newestPublishedAt).toEqual(settledOlder);
    });

    it('gives an item up after the max retries and records it as seen', async () => {
      const l = feedLevers();
      const items = [dated(1, 3), dated(2, 5)];
      let cursor: ResearchFeedCursor | null = null;
      const seenAfter: boolean[] = [];
      let lastFloor: Date | null = null;
      for (let run = 1; run <= RESEARCH_FEED_MAX_RETRIES; run += 1) {
        const { ports } = feedPorts(items);
        ports.judge = vi.fn(failJudge([hit(1).url]));
        const result: ResearchRunResult = await executeResearchRun(l, `run-${run}`, ports, cursor);
        cursor = result.feedCursor!;
        seenAfter.push(cursor.seenKeys.includes(keyOf(1)));
        lastFloor = cursor.newestPublishedAt;
      }
      expect(seenAfter).toEqual([false, false, true]);
      expect(cursor!.retries).toEqual([]);
      // The failing item never moves the floor, given up or not.
      expect(lastFloor).toEqual(daysAgo(5));
    });

    it('prunes a retry whose item left the feed, and clears one that settled', async () => {
      const l = feedLevers();
      const stored = cursorFor(l, {
        retries: [
          { key: keyOf(8), attempts: 2 },
          { key: keyOf(1), attempts: 1 },
        ],
      });
      const { ports } = feedPorts([dated(1, 1)]);
      const result = await executeResearchRun(l, 'run-1', ports, stored);
      expect(result.feedCursor!.retries).toEqual([]);
    });

    it('carries an untouched retry forward while its item is still in the feed', async () => {
      const l = feedLevers({ maxResults: 1 });
      const stored = cursorFor(l, { retries: [{ key: keyOf(3), attempts: 2 }] });
      // Item 1 is older, so it is taken first; item 3 is left for a later run.
      const { ports } = feedPorts([dated(1, 5), dated(3, 1)]);
      const result = await executeResearchRun(l, 'run-1', ports, stored);
      expect(result.feedCursor!.retries).toEqual([{ key: keyOf(3), attempts: 2 }]);
    });
  });

  describe('every propose outcome', () => {
    const outcomes: Record<ProposalOutcome['outcome'], ProposalOutcome> = {
      proposed: proposed(),
      duplicate_pending: { outcome: 'duplicate_pending', proposalId: 'x' },
      already_in_lake: { outcome: 'already_in_lake', reason: 'prior_approval' },
      suppressed_by_tombstone: { outcome: 'suppressed_by_tombstone', proposalId: 'x' },
      unusable_source: { outcome: 'unusable_source', reason: 'not_http_url' },
    };

    it('has a settled entry for exactly the outcomes the propose step can return', () => {
      expect(Object.keys(SETTLED_PROPOSE_OUTCOMES).sort()).toEqual(Object.keys(outcomes).sort());
    });

    it.each(Object.entries(outcomes))('%s is settled', async (_name, outcome) => {
      const l = feedLevers();
      const { ports } = feedPorts([dated(1, 1)], { propose: vi.fn(async () => outcome) });
      const result = await executeResearchRun(l, 'run-1', ports);
      expect(result.feedCursor!.seenKeys).toEqual([keyOf(1)]);
      expect(result.feedCursor!.retries).toEqual([]);
    });

    it('does not record an unlisted outcome as settled', async () => {
      const l = feedLevers();
      const unknown = { outcome: 'brand_new' } as unknown as ProposalOutcome;
      const { ports } = feedPorts([dated(1, 1)], { propose: vi.fn(async () => unknown) });
      const result = await executeResearchRun(l, 'run-1', ports);
      expect(result.feedCursor!.seenKeys).toEqual([]);
      expect(result.feedCursor!.newestPublishedAt).toBeNull();
    });
  });

  describe('items not reached', () => {
    const sevenItems = () => [dated(1, 7), dated(2, 6), dated(3, 5), dated(4, 4)];

    it('hold the floor after proposal_limit', async () => {
      const l = feedLevers({ maxProposals: 2 });
      const { ports } = feedPorts(sevenItems());
      const result = await executeResearchRun(l, 'run-1', ports);
      expect(result.stopReason).toBe('proposal_limit');
      expect(result.feedCursor!.seenKeys).toEqual([keyOf(1), keyOf(2)]);
      expect(result.feedCursor!.newestPublishedAt).toEqual(daysAgo(6));
    });

    it('hold the floor after time_budget', async () => {
      const l = feedLevers();
      let calls = 0;
      const { ports } = feedPorts(sevenItems(), { remainingTimeMs: () => (calls++ < 2 ? 1_000_000 : 0) });
      const result = await executeResearchRun(l, 'run-1', ports);
      expect(result.stopReason).toBe('time_budget');
      expect(result.feedCursor!.seenKeys).toEqual([keyOf(1), keyOf(2)]);
      expect(result.feedCursor!.newestPublishedAt).toEqual(daysAgo(6));
    });

    it('hold the floor after cost_ceiling', async () => {
      const l = feedLevers({ costCeilingMicroUsd: 2_000 });
      const { ports } = feedPorts(sevenItems());
      const result = await executeResearchRun(l, 'run-1', ports);
      expect(result.stopReason).toBe('cost_ceiling');
      expect(result.feedCursor!.seenKeys).toEqual([keyOf(1), keyOf(2)]);
      expect(result.feedCursor!.newestPublishedAt).toEqual(daysAgo(6));
    });

    it('reports judge_unavailable as a failed judge step so the caller writes no cursor', async () => {
      const l = feedLevers();
      const { ports } = feedPorts(sevenItems());
      ports.judge = vi.fn(async () => ({ outcome: 'failed' as const, error: 'down', costMicroUsd: 0 }));
      const result = await executeResearchRun(l, 'run-1', ports);
      expect(result.stopReason).toBe('judge_unavailable');
      expect(result.judgeStepFailed).toBe(true);
    });
  });
});
