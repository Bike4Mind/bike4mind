/**
 * Reconciliation for risk evidence: queues an evidence refresh for every account younger than
 * SIGNUP_RISK_WINDOW_DAYS whose review is not settled, so a trigger that was dropped (an SQS send
 * that failed, a refresh that exhausted its retries) is repaired within one run. Repair runs before the
 * coverage report, which is isolated so its failure cannot skip it. Live activity is
 * the primary trigger; this only catches what it missed. Requests are debounced per account, so an
 * account with a refresh already pending costs one conditional update.
 *
 * It deliberately does not rescore: refreshSignupRiskScore can move none to pending, and pending
 * holds AI access, so a scheduled rescore would add holds no admin asked for. Evidence is shadow-only.
 *
 * Each run also reports evidence coverage (signup metadata, JA4, WAF fields) over the same window,
 * the baseline for how much of the evidence is unknown.
 */

import { Context } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { Logger } from '@bike4mind/observability';
import type { IUserRepository, RiskEvidenceCoverage } from '@bike4mind/common';
import { connectDB, userRepository } from '@bike4mind/database';
import { emitMetrics } from '@bike4mind/server-utils/utils/cloudwatch';
import { Config } from '@bike4mind/server-utils/utils/config';
import { requestRiskEvidenceRefresh } from '@server/auth/riskEvidence';
import { RISK_EVIDENCE_NAMESPACE, RiskEvidenceMetrics } from '@workers/queueHandlers/riskEvidence';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { Resource } from 'sst';

export const SIGNUP_RISK_WINDOW_DAYS = 14;
const BATCH_SIZE = 200;

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

export const windowStart = (now: Date) => new Date(now.getTime() - SIGNUP_RISK_WINDOW_DAYS * 24 * 60 * 60 * 1000);

type RequestRiskEvidenceRefreshResult = Awaited<ReturnType<typeof requestRiskEvidenceRefresh>>;

export type SweepRequestOutcomes = Record<RequestRiskEvidenceRefreshResult, number>;

/** Candidate ids handled concurrently: each request is one update and maybe one SQS send. */
const REQUEST_CONCURRENCY = 10;

/** Pages through the candidates in id order and requests a refresh for each; returns the outcome counts. */
export async function sweepRiskEvidence({
  users,
  request,
  now,
}: {
  users: Pick<IUserRepository, 'findRiskScoringCandidateIds'>;
  request: (userId: string) => Promise<RequestRiskEvidenceRefreshResult>;
  now: Date;
}): Promise<SweepRequestOutcomes> {
  const since = windowStart(now);
  const outcomes: SweepRequestOutcomes = { queued: 0, deduped: 0, failed: 0 };
  let afterId: string | undefined;
  for (;;) {
    const ids = await users.findRiskScoringCandidateIds(since, { afterId, limit: BATCH_SIZE });
    for (let start = 0; start < ids.length; start += REQUEST_CONCURRENCY) {
      const results = await Promise.all(ids.slice(start, start + REQUEST_CONCURRENCY).map(request));
      for (const result of results) outcomes[result] += 1;
    }
    if (ids.length < BATCH_SIZE) return outcomes;
    afterId = ids[ids.length - 1];
  }
}

/** Coverage counts as metrics; shares are derived in the dashboard so no ratio hides a zero denominator. */
export const coverageMetrics = (coverage: RiskEvidenceCoverage, stage: string) =>
  Object.entries(coverage).map(([field, value]) => ({
    name: 'Coverage',
    value,
    dimensions: { Stage: stage, Field: field },
    unit: StandardUnit.Count,
  }));

export const requestMetrics = (outcomes: SweepRequestOutcomes, stage: string) =>
  Object.entries(outcomes).map(([outcome, value]) => ({
    name: RiskEvidenceMetrics.REQUESTS,
    value,
    dimensions: { Stage: stage, Outcome: outcome },
    unit: StandardUnit.Count,
  }));

export async function handler(_event: unknown, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);

  const stage = Resource.App.stage;
  const now = new Date();
  // Repair first: a failing coverage aggregate must never skip it.
  const outcomes = await sweepRiskEvidence({
    users: userRepository,
    request: userId => requestRiskEvidenceRefresh(userId, 'sweep', logger),
    now,
  });
  logger.log('Risk evidence sweep finished', outcomes);
  await emitMetrics(RISK_EVIDENCE_NAMESPACE, requestMetrics(outcomes, stage));

  try {
    const coverage = await userRepository.riskEvidenceCoverage(windowStart(now));
    logger.log('Risk evidence coverage', { windowDays: SIGNUP_RISK_WINDOW_DAYS, ...coverage });
    await emitMetrics(RISK_EVIDENCE_NAMESPACE, coverageMetrics(coverage, stage));
  } catch (error) {
    logger.warn('Risk evidence coverage failed', { error: error instanceof Error ? error.message : String(error) });
  }
}
