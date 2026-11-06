/**
 * Builds the only thing an advisory abuse assessment sends to a provider: an allowlisted,
 * pseudonymous summary of a shadow detection (contract in b4m-core/common/src/schemas/abuseAssessment.ts).
 *
 * Every field is copied by name from a typed source and the result is parsed with a strict schema,
 * so identity (IP, ASN, country, email, user id), free text (the detection summary, signal labels,
 * failure messages) and anything added upstream later can never ride along.
 */

import { createHash } from 'node:crypto';
import {
  ABUSE_ASSESSMENT_EVIDENCE_VERSION,
  ABUSE_ASSESSMENT_MAX_ACCOUNTS,
  ABUSE_ASSESSMENT_MAX_SIGNALS,
  ABUSE_ASSESSMENT_MAX_SUMMARY_CHARS,
  ABUSE_ASSESSMENT_POLICY_VERSION,
  RISK_EVIDENCE_MISSING_REASONS,
  RISK_EVIDENCE_VERSION,
  abuseAssessmentFeatureSummarySchema,
  riskEvidenceFactValueSchemas,
  type AbuseAssessmentAccount,
  type AbuseAssessmentAccountProfile,
  type AbuseAssessmentAccountEvidence,
  type AbuseAssessmentFeatureSummary,
  type AbuseAssessmentGroupEvidence,
  type DecisionModelId,
  type RiskEvidenceFacts,
  type RiskEvidenceSummary,
  type ShadowDetectionItem,
} from '@bike4mind/common';

export type AssessedAccountSource = {
  id: string;
  createdAt: Date | null;
  summary: RiskEvidenceSummary | null;
  /** From accountProfile.ts; null when the account could not be read. */
  profile: AbuseAssessmentAccountProfile | null;
};

const HOUR_MS = 60 * 60 * 1000;
const SIGNAL_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const hoursBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / HOUR_MS);
const finiteOrNull = (value: number | null) => (value !== null && Number.isFinite(value) ? value : null);

type ProjectedFact<T> =
  | { status: 'observed'; value: T; sampleCount: number; truncated: boolean }
  | { status: 'missing'; reason: (typeof RISK_EVIDENCE_MISSING_REASONS)[number] }
  | { status: 'failed' };

// Re-parsing the value through its schema drops any key the schema does not name.
function projectFact<T>(valueSchema: { parse(value: unknown): T }, fact: ProjectedFact<T>): ProjectedFact<T> {
  switch (fact.status) {
    case 'observed':
      return {
        status: 'observed',
        value: valueSchema.parse(fact.value),
        sampleCount: fact.sampleCount,
        truncated: fact.truncated,
      };
    case 'missing':
      return { status: 'missing', reason: fact.reason };
    case 'failed':
      return { status: 'failed' };
  }
}

const v = riskEvidenceFactValueSchemas;

const projectEvidence = (facts: RiskEvidenceFacts): AbuseAssessmentAccountEvidence => ({
  signupNetwork: projectFact(v.signupNetwork, facts.signupNetwork),
  edgeFingerprint: projectFact(v.edgeFingerprint, facts.edgeFingerprint),
  wafSignals: projectFact(v.wafSignals, facts.wafSignals),
  authActivity: projectFact(v.authActivity, facts.authActivity),
  apiKeys: projectFact(v.apiKeys, facts.apiKeys),
  usage: projectFact(v.usage, facts.usage),
  concurrency: projectFact(v.concurrency, facts.concurrency),
  sensitiveActions: projectFact(v.sensitiveActions, facts.sensitiveActions),
});

// Ages are measured against the detection, not the clock, so a re-run with the same evidence
// produces the same summary (and the same cache key).
const projectAccount = (
  source: AssessedAccountSource | undefined,
  ref: string,
  detectedAt: Date
): AbuseAssessmentAccount => {
  const summary = source?.summary?.version === RISK_EVIDENCE_VERSION ? source.summary : null;
  return {
    ref,
    accountAgeHours: source?.createdAt ? Math.max(0, hoursBetween(source.createdAt, detectedAt)) : null,
    evidenceAgeHours: summary ? hoursBetween(detectedAt, summary.computedAt) : null,
    evidence: summary ? projectEvidence(summary.facts) : null,
    profile: source?.profile ?? null,
  };
};

export const accountRef = (index: number) => `acct_${index + 1}`;

/**
 * The summary for one detection. Accounts keep the detection's order and are referenced as
 * acct_1..N; past the account cap or the size cap, trailing accounts are dropped and counted.
 */
export function buildFeatureSummary({
  detection,
  accounts,
  group,
}: {
  detection: ShadowDetectionItem;
  accounts: readonly AssessedAccountSource[];
  group: AbuseAssessmentGroupEvidence | null;
}): AbuseAssessmentFeatureSummary {
  const byId = new Map(accounts.map(account => [account.id, account]));
  const included = detection.userIds.slice(0, ABUSE_ASSESSMENT_MAX_ACCOUNTS);
  const projected = included.map((userId, index) =>
    projectAccount(byId.get(userId), accountRef(index), detection.detectedAt)
  );

  const build = (kept: AbuseAssessmentAccount[]): AbuseAssessmentFeatureSummary =>
    abuseAssessmentFeatureSummarySchema.parse({
      evidenceVersion: ABUSE_ASSESSMENT_EVIDENCE_VERSION,
      detection: {
        detector: detection.detector,
        detectorPolicyVersion: detection.policyVersion,
        windowMinutes: finiteOrNull(detection.windowMinutes),
        hostingNetwork: detection.network?.hosting ?? null,
        signals: detection.signals
          .filter(signal => SIGNAL_KEY.test(signal.key))
          .slice(0, ABUSE_ASSESSMENT_MAX_SIGNALS)
          .map(signal => ({
            key: signal.key,
            observed: finiteOrNull(signal.observed),
            threshold: finiteOrNull(signal.threshold),
          })),
      },
      accounts: kept,
      accountsOmitted: detection.userIds.length - kept.length,
      group: group
        ? { ...group, memberRefs: group.memberRefs.filter(ref => kept.some(account => account.ref === ref)) }
        : null,
    });

  let kept = projected;
  let summary = build(kept);
  while (kept.length > 0 && JSON.stringify(summary).length > ABUSE_ASSESSMENT_MAX_SUMMARY_CHARS) {
    kept = kept.slice(0, -1);
    summary = build(kept);
  }
  return summary;
}

// Counts are compared in power-of-two bands, so one more login or a cent of spend does not count as
// new evidence; a doubling does.
const band = (value: number) => {
  if (!Number.isFinite(value)) return value;
  const magnitude = Math.abs(value);
  if (magnitude <= 4) return Math.round(value);
  return Math.sign(value) * 2 ** Math.ceil(Math.log2(magnitude));
};

const coarsen = (value: unknown): unknown => {
  if (typeof value === 'number') return band(value);
  if (Array.isArray(value)) return value.map(coarsen);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, coarsen(nested)])
    );
  }
  return value;
};

/** Stable hash of the summary at the resolution that counts as a meaningful change. */
export const evidenceHash = (summary: AbuseAssessmentFeatureSummary): string =>
  createHash('sha256')
    .update(JSON.stringify(coarsen(summary)))
    .digest('hex');

export const assessmentCacheKey = (detectionId: string, hash: string, model: DecisionModelId): string =>
  createHash('sha256').update(`${detectionId}|${hash}|${ABUSE_ASSESSMENT_POLICY_VERSION}|${model}`).digest('hex');

/** Stable 0-99 bucket per detection, so a rollout percentage selects the same detections every run. */
export const rolloutBucket = (detectionId: string): number =>
  createHash('sha256').update(detectionId).digest().readUInt32BE(0) % 100;
