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
  ACCOUNT_CAMPAIGN_AXIS_OF,
  ABUSE_ASSESSMENT_MAX_ACCOUNTS,
  ABUSE_ASSESSMENT_MAX_SIGNALS,
  ABUSE_ASSESSMENT_MAX_SUMMARY_CHARS,
  ABUSE_ASSESSMENT_POLICY_VERSION,
  RISK_EVIDENCE_MISSING_REASONS,
  RISK_EVIDENCE_VERSION,
  abuseAssessmentFeatureSummarySchema,
  riskEvidenceFactValueSchemas,
  type AbuseAssessmentAccount,
  type AbuseAssessmentAccountEvidence,
  type AbuseAssessmentFeatureSummary,
  type AbuseAssessmentGroupEvidence,
  type AbuseAssessmentRequestActivity,
  abuseAssessmentRequestActivitySchema,
  completionSequenceEvidenceSchema,
  completionSynchronyEvidenceSchema,
  type DecisionModelId,
  type RiskEvidenceFacts,
  type RiskEvidenceSummary,
  type ShadowDetectionItem,
} from '@bike4mind/common';

export type AssessedAccountSource = {
  id: string;
  createdAt: Date | null;
  summary: RiskEvidenceSummary | null;
  requests?: AbuseAssessmentRequestActivity;
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
    ...(source?.requests ? { requests: abuseAssessmentRequestActivitySchema.parse(source.requests) } : {}),
  };
};

function projectCompletionSynchrony(detection: ShadowDetectionItem, kept: AbuseAssessmentAccount[]) {
  if (detection.detector !== 'completionSynchrony') return undefined;
  const parsed = completionSynchronyEvidenceSchema.safeParse(detection.completionSynchrony);
  if (!parsed.success)
    return { status: 'incomplete' as const, reviewOnly: true as const, reason: 'source_missing' as const };
  if (kept.length !== detection.userIds.length || kept.length < 3)
    return { status: 'incomplete' as const, reviewOnly: true as const, reason: 'members_omitted' as const };
  const value = parsed.data;
  return {
    status: 'observed' as const,
    reviewOnly: true as const,
    memberRefs: kept.map(account => account.ref),
    source: value.source,
    windowHours: value.windowHours,
    eventsScanned: value.eventsScanned,
    legacyRows: value.legacyRows,
    scanTruncated: value.scanTruncated,
    bursts: value.bursts,
    synchronizedModelSwitches: value.synchronizedModelSwitches,
    distinctRequestedModels: value.distinctRequestedModels,
    maxStartSkewMilliseconds: value.maxStartSkewMilliseconds,
    completedRequests: value.completedRequests,
    dailyCapRejectedRequests: value.dailyCapRejectedRequests,
    otherRejectedRequests: value.otherRejectedRequests,
    interruptedOrUnknownRequests: value.interruptedOrUnknownRequests,
    ...(value.creditExposure
      ? {
          creditExposure: {
            scope: value.creditExposure.scope,
            creditsCharged: value.creditExposure.creditsCharged,
            grantFundedCredits: value.creditExposure.grantFundedCredits,
            unknownFundingCredits: value.creditExposure.unknownFundingCredits,
            scanTruncated: value.creditExposure.scanTruncated,
          },
        }
      : {}),
  };
}

function projectCompletionSequence(detection: ShadowDetectionItem, kept: AbuseAssessmentAccount[]) {
  if (detection.detector !== 'completionSequence') return undefined;
  const source = completionSequenceEvidenceSchema.safeParse(detection.completionSequence);
  if (!source.success)
    return { status: 'incomplete' as const, reviewOnly: true as const, reason: 'source_missing' as const };
  if (kept.length !== detection.userIds.length || kept.length < 3)
    return {
      status: 'incomplete' as const,
      reviewOnly: true as const,
      reason: 'members_omitted' as const,
    };
  const sequence = source.data;
  return {
    status: 'observed' as const,
    reviewOnly: true as const,
    memberRefs: kept.map(account => account.ref),
    source: sequence.source,
    windowHours: sequence.windowHours,
    eventsScanned: sequence.eventsScanned,
    scanTruncated: sequence.scanTruncated,
    rounds: sequence.rounds,
    minRequestsPerRound: sequence.minRequestsPerRound,
    maxRequestsPerRound: sequence.maxRequestsPerRound,
    maxRoundSpanSeconds: sequence.maxRoundSpanSeconds,
    minGapSeconds: sequence.minGapSeconds,
    maxGapSeconds: sequence.maxGapSeconds,
  };
}

export const accountRef = (index: number) => `acct_${index + 1}`;

function projectCampaign(detection: ShadowDetectionItem, kept: AbuseAssessmentAccount[]) {
  if (detection.detector !== 'accountCampaign' || !detection.group) return undefined;
  const group = detection.group;
  const refs = new Map(detection.userIds.slice(0, kept.length).map((id, index) => [id, accountRef(index)]));
  const memberRefs = (ids: string[]) => [...new Set(ids.flatMap(id => refs.get(id) ?? []))];
  const evidence = group.evidence
    .map(entry => ({
      relationship: entry.relationship,
      axis: ACCOUNT_CAMPAIGN_AXIS_OF[entry.relationship],
      population: entry.population,
      memberRefs: memberRefs(entry.userIds),
    }))
    .filter(entry => entry.memberRefs.length >= 2);
  return {
    members: group.members.flatMap(member => {
      const ref = refs.get(member.userId);
      return ref ? [{ ref, membership: member.membership }] : [];
    }),
    evidence: evidence.slice(0, ABUSE_ASSESSMENT_MAX_SIGNALS),
    ignored: group.ignored.slice(0, ABUSE_ASSESSMENT_MAX_SIGNALS).map(entry => ({
      relationship: entry.relationship,
      reason: entry.reason,
      population: entry.population,
      memberCount: entry.memberCount,
    })),
    truncated:
      group.truncated ||
      group.members.length > refs.size ||
      evidence.length > ABUSE_ASSESSMENT_MAX_SIGNALS ||
      group.ignored.length > ABUSE_ASSESSMENT_MAX_SIGNALS,
  };
}

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
      evidenceVersion: RISK_EVIDENCE_VERSION,
      detection: {
        detector: detection.detector,
        detectorPolicyVersion: detection.policyVersion,
        windowMinutes: finiteOrNull(detection.windowMinutes),
        hostingNetwork: detection.network?.hosting ?? null,
        campaign: projectCampaign(detection, kept),
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
      completionSequence: projectCompletionSequence(detection, kept),
      completionSynchrony: projectCompletionSynchrony(detection, kept),
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
