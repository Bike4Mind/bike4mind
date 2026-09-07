import { describe, it, expect, vi } from 'vitest';
import type { ResearchRunLevers } from '@bike4mind/common';
import { RESEARCH_RUN_PRODUCER } from '@bike4mind/common';
import type { ProposalCandidate, ProposalOutcome } from '../dataLakeService/proposeDataLakeContent';
import { executeResearchRun, type ResearchCandidate, type ResearchRunPorts } from './executeResearchRun';

const NOW = new Date('2026-03-01T12:00:00.000Z');

const levers = (overrides: Partial<ResearchRunLevers> = {}): ResearchRunLevers => ({
  query: 'coastal erosion',
  maxResults: 10,
  maxProposals: 5,
  allowedDomains: [],
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
      return { relevance: 1, costMicroUsd: 1_000 };
    }),
    fetchSource: vi.fn(async (url: string) => {
      calls.fetched.push(url);
      return { title: 'Fetched title', text: 'body text' };
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

  it('proposes a cleared candidate with its run provenance and advisory confidence', async () => {
    const { ports, calls } = makePorts();
    (ports.judge as ReturnType<typeof vi.fn>).mockResolvedValue({ relevance: 0.82, costMicroUsd: 500 });

    const result = await executeResearchRun(levers(), 'run-1', ports);

    expect(calls.proposals).toHaveLength(1);
    expect(calls.proposals[0]).toMatchObject({
      sourceUrl: 'https://example.com/1',
      // The page's own title wins over the search hit's rendering of it.
      title: 'Fetched title',
      text: 'body text',
      proposedTags: ['research'],
      confidence: 0.82,
      provenance: { producer: RESEARCH_RUN_PRODUCER, runId: 'run-1', query: 'coastal erosion', retrievedAt: NOW },
    });
    expect(result.totals.proposed).toBe(1);
    expect(result.spentMicroUsd).toBe(500);
    expect(result.stopReason).toBe('exhausted');
  });

  it('falls back to the search hit title when the fetch yields none', async () => {
    const { ports, calls } = makePorts();
    (ports.fetchSource as ReturnType<typeof vi.fn>).mockResolvedValue({ title: '', text: 'body' });
    await executeResearchRun(levers(), 'run-1', ports);
    expect(calls.proposals[0].title).toBe('Result 1');
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

    it('drops everything outside an allow list', async () => {
      const { ports, calls } = makePorts({ candidates: [hit(1, 'other.com'), hit(2, 'docs.example.com')] });

      const result = await executeResearchRun(levers({ allowedDomains: ['example.com'] }), 'run-1', ports);

      expect(calls.judged).toEqual(['https://docs.example.com/2']);
      expect(result.totals.filteredBySource).toBe(1);
    });
  });

  // Rule 2: the ceiling is a precondition of the NEXT judgment, never a post-check on the last.
  describe('rule 2 - the cost ceiling', () => {
    it('stops before the judgment that would exceed it', async () => {
      const { ports } = makePorts({ candidates: [hit(1), hit(2), hit(3)] });
      (ports.judge as ReturnType<typeof vi.fn>).mockResolvedValue({ relevance: 0.1, costMicroUsd: 600 });

      const result = await executeResearchRun(levers({ costCeilingMicroUsd: 1_000 }), 'run-1', ports);

      // Two judgments (600, then 1200 >= 1000 stops the third), never a third. Counted off the spy
      // rather than `calls.judged`, which the mockResolvedValue above replaced.
      expect(ports.judge).toHaveBeenCalledTimes(2);
      expect(result.spentMicroUsd).toBe(1_200);
      expect(result.stopReason).toBe('cost_ceiling');
    });

    it('treats an unreachable model as below-relevance, so a broken model proposes nothing', async () => {
      const { ports } = makePorts({ candidates: [hit(1), hit(2)] });
      (ports.judge as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await executeResearchRun(levers(), 'run-1', ports);

      // A null judgment reports no cost, but is still conservative for the candidate.
      expect(result.totals.belowRelevance).toBe(2);
      expect(result.totals.proposed).toBe(0);
    });
  });

  // Rule 3: fetch only what cleared the judgment.
  it('never fetches a candidate below the relevance floor', async () => {
    const { ports, calls } = makePorts({ candidates: [hit(1), hit(2)] });
    (ports.judge as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ relevance: 0.2, costMicroUsd: 10 })
      .mockResolvedValueOnce({ relevance: 0.9, costMicroUsd: 10 });

    const result = await executeResearchRun(levers({ minRelevance: 0.6 }), 'run-1', ports);

    expect(calls.fetched).toEqual(['https://example.com/2']);
    expect(result.totals.belowRelevance).toBe(1);
    expect(result.totals.proposed).toBe(1);
  });

  it('counts a failed fetch and moves on', async () => {
    const { ports, calls } = makePorts({ candidates: [hit(1), hit(2)] });
    (ports.fetchSource as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ title: 't', text: 'x' });

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
      .mockResolvedValueOnce({ relevance: 0.1, costMicroUsd: 10 })
      .mockResolvedValueOnce({ relevance: 0.9, costMicroUsd: 10 });

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
});
