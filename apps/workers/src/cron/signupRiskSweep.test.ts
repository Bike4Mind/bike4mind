import { describe, it, expect, vi, beforeEach } from 'vitest';

const { emitMetrics, riskEvidenceCoverage, findRiskScoringCandidateIds, requestRiskEvidenceRefresh } = vi.hoisted(
  () => ({
    emitMetrics: vi.fn(async () => undefined),
    riskEvidenceCoverage: vi.fn(),
    findRiskScoringCandidateIds: vi.fn(),
    requestRiskEvidenceRefresh: vi.fn(),
  })
);

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(async () => undefined),
  userRepository: { riskEvidenceCoverage, findRiskScoringCandidateIds },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://%STAGE%' } }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetrics }));
vi.mock('@server/auth/riskEvidence', () => ({ requestRiskEvidenceRefresh }));
vi.mock('@workers/queueHandlers/riskEvidence', () => ({
  RISK_EVIDENCE_NAMESPACE: 'test',
  RiskEvidenceMetrics: { REQUESTS: 'Requests' },
}));

import type { Context } from 'aws-lambda';
import {
  SIGNUP_RISK_WINDOW_DAYS,
  coverageMetrics,
  handler,
  requestMetrics,
  sweepRiskEvidence,
} from './signupRiskSweep';

const NOW = new Date('2026-10-26T12:00:00Z');

/** A candidate list served in pages, the way findRiskScoringCandidateIds pages by id. */
const pagedUsers = (ids: string[]) => ({
  findRiskScoringCandidateIds: vi.fn(async (_since: Date, { afterId, limit }: { afterId?: string; limit: number }) => {
    const start = afterId ? ids.indexOf(afterId) + 1 : 0;
    return ids.slice(start, start + limit);
  }),
});

describe('sweepRiskEvidence', () => {
  it('asks only for accounts inside the window', async () => {
    const users = pagedUsers([]);

    await sweepRiskEvidence({ users, request: vi.fn(async () => 'queued' as const), now: NOW });

    const since = users.findRiskScoringCandidateIds.mock.calls[0][0];
    expect(NOW.getTime() - since.getTime()).toBe(SIGNUP_RISK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  });

  it('requests a refresh for every candidate across pages, each once, continuing after the last id of a full page', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `u${String(i).padStart(4, '0')}`);
    const users = pagedUsers(ids);
    const request = vi.fn(async () => 'queued' as const);

    await expect(sweepRiskEvidence({ users, request, now: NOW })).resolves.toEqual({
      queued: 450,
      deduped: 0,
      failed: 0,
    });

    expect(request.mock.calls.map(([id]) => id)).toEqual(ids);
    expect(users.findRiskScoringCandidateIds.mock.calls.map(([, page]) => page.afterId)).toEqual([
      undefined,
      'u0199',
      'u0399',
    ]);
  });

  it('stops after an exactly full last page with one empty read', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `u${String(i).padStart(4, '0')}`);
    const users = pagedUsers(ids);

    await expect(
      sweepRiskEvidence({ users, request: vi.fn(async () => 'queued' as const), now: NOW })
    ).resolves.toMatchObject({ queued: 200 });
    expect(users.findRiskScoringCandidateIds).toHaveBeenCalledTimes(2);
  });

  it('counts each request outcome', async () => {
    const users = pagedUsers(['a', 'b', 'c', 'd']);
    const results = { a: 'queued', b: 'deduped', c: 'deduped', d: 'failed' } as const;

    await expect(
      sweepRiskEvidence({ users, request: async id => results[id as keyof typeof results], now: NOW })
    ).resolves.toEqual({ queued: 1, deduped: 2, failed: 1 });
  });
});

describe('coverageMetrics', () => {
  it('reports each coverage count as its own Field dimension', () => {
    expect(coverageMetrics({ accounts: 10, withSignupMeta: 8, withJa4: 0, withWafSignals: 3 }, 'test')).toEqual([
      expect.objectContaining({ name: 'Coverage', value: 10, dimensions: { Stage: 'test', Field: 'accounts' } }),
      expect.objectContaining({ value: 8, dimensions: { Stage: 'test', Field: 'withSignupMeta' } }),
      expect.objectContaining({ value: 0, dimensions: { Stage: 'test', Field: 'withJa4' } }),
      expect.objectContaining({ value: 3, dimensions: { Stage: 'test', Field: 'withWafSignals' } }),
    ]);
  });
});

describe('requestMetrics', () => {
  it('reports each outcome as an Outcome dimension of the Requests metric', () => {
    expect(requestMetrics({ queued: 3, deduped: 1, failed: 0 }, 'test')).toEqual([
      expect.objectContaining({ name: 'Requests', value: 3, dimensions: { Stage: 'test', Outcome: 'queued' } }),
      expect.objectContaining({ value: 1, dimensions: { Stage: 'test', Outcome: 'deduped' } }),
      expect.objectContaining({ value: 0, dimensions: { Stage: 'test', Outcome: 'failed' } }),
    ]);
  });
});

describe('handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findRiskScoringCandidateIds.mockResolvedValue(['u1', 'u2']);
    requestRiskEvidenceRefresh.mockResolvedValue('queued');
  });

  it('still runs the sweep and emits its outcomes when the coverage aggregate throws', async () => {
    riskEvidenceCoverage.mockRejectedValue(new Error('aggregate timeout'));

    await expect(handler({}, { awsRequestId: 'r1' } as Context)).resolves.toBeUndefined();

    expect(requestRiskEvidenceRefresh).toHaveBeenCalledTimes(2);
    expect(emitMetrics).toHaveBeenCalledTimes(1);
    expect(emitMetrics).toHaveBeenCalledWith(
      'test',
      expect.arrayContaining([expect.objectContaining({ name: 'Requests', value: 2 })])
    );
  });

  it('requests refreshes before reading coverage', async () => {
    riskEvidenceCoverage.mockResolvedValue({ accounts: 2, withSignupMeta: 2, withJa4: 1, withWafSignals: 0 });

    await handler({}, { awsRequestId: 'r1' } as Context);

    expect(requestRiskEvidenceRefresh.mock.invocationCallOrder[0]).toBeLessThan(
      riskEvidenceCoverage.mock.invocationCallOrder[0]
    );
    expect(emitMetrics).toHaveBeenCalledTimes(2);
  });
});
