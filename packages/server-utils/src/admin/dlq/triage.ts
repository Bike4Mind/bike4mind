import { createHash } from 'node:crypto';
import {
  AdminAiConfigSchema,
  AdminAiStoredConfigSchema,
  dlqTriageEvidenceSchema,
  type AdminAiSuggestionItem,
  type DlqTriageEvidence,
} from '@bike4mind/common';
import { adminAiSuggestionRepository, adminSettingsRepository, dlqFailureRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { getDlqByLabel, getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { getAdminAiClassReadiness } from '../ai/readiness';
import { recordAdminAiAttempt } from '../ai/telemetry';
import { DLQ_TRIAGE_POLICY_VERSION, recommendDlqAction } from './triagePolicy';
import { buildDlqTriageEvidence, sampleDlqConsumerLogs, refreshDlqExpiry } from './triageEvidence';

export const dlqTriageEntityId = (queueLabel: string, messageId: string) => `${queueLabel}:${messageId}`;

function decisionHash(action: string, evidence: DlqTriageEvidence) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        action,
        failurePresent: evidence.failureSource === 'recorded',
        failureCategory: evidence.failureCategory,
        consumerVersion: evidence.consumerVersion,
        failedAt: evidence.failedAt ?? null,
        sentTimestamp: evidence.sentTimestamp ?? null,
        retentionSeconds: evidence.retentionSeconds ?? null,
        entityPresent: evidence.entityContext === 'present-id-withheld',
        owner: evidence.owner,
      })
    )
    .digest('hex');
}

export async function loadDlqTriageConfig() {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    {
      names: ['adminAiConfig'],
      skipCache: true,
    }
  );
  return AdminAiStoredConfigSchema.parse(getSettingsValue('adminAiConfig', settings, AdminAiConfigSchema.parse({})));
}

export async function visibleDlqSuggestion(
  queueLabel: string,
  messageId: string
): Promise<AdminAiSuggestionItem | null> {
  const config = await loadDlqTriageConfig();
  if (!config.enabled || config.features.dlqTriage.mode === 'off' || config.dlqQueueModes[queueLabel] === 'off')
    return null;
  const suggestion = await adminAiSuggestionRepository.findLatestForEntity(
    'dlqTriage',
    dlqTriageEntityId(queueLabel, messageId)
  );
  if (!suggestion || suggestion.policyVersion !== DLQ_TRIAGE_POLICY_VERSION || !suggestion.actionClass) return null;
  const readiness = await getAdminAiClassReadiness({
    feature: 'dlqTriage',
    actionClass: suggestion.actionClass,
    policyVersion: DLQ_TRIAGE_POLICY_VERSION,
  });
  if (!readiness.canRecommend) return null;
  const action = suggestion.proposedAction;
  if (action && typeof action === 'object' && 'facts' in action) {
    const evidence = dlqTriageEvidenceSchema.safeParse(action.facts);
    if (evidence.success) {
      return { ...suggestion, proposedAction: { ...action, facts: refreshDlqExpiry(evidence.data) } };
    }
  }
  return suggestion;
}

export async function triageDlqMessage(
  queueLabel: string,
  messageId: string,
  facts: {
    sentTimestamp?: string;
    retentionSeconds?: number;
    logsUrl?: string | null;
    sourceQueueName?: string | null;
    sourceQueueUrl?: string | null;
    entityPresent?: boolean;
    logFallbackDeadline?: number;
  } = {}
): Promise<AdminAiSuggestionItem | null> {
  const startedAt = new Date();
  const config = await loadDlqTriageConfig();
  const mode = config.features.dlqTriage.mode;
  if (!config.enabled || mode === 'off' || config.dlqQueueModes[queueLabel] === 'off') {
    await recordAdminAiAttempt({
      feature: 'dlqTriage',
      policyVersion: DLQ_TRIAGE_POLICY_VERSION,
      outcome: 'skip',
      skipReason: 'disabled',
      calls: 0,
      knownCostUsd: 0,
      costUnknown: false,
      startedAt,
      finishedAt: new Date(),
    });
    return null;
  }
  const entry = getDlqByLabel(queueLabel);
  if (!entry) return null;
  const sourceName =
    facts.sourceQueueName !== undefined
      ? facts.sourceQueueName
      : entry.sourceQueue
        ? new URL(getSourceQueueUrl(entry.sourceQueue)).pathname.split('/').pop()
        : undefined;
  const failures = sourceName
    ? await dlqFailureRepository.findForMessages(sourceName, [messageId]).catch(() => {
        Logger.warn('[DLQ Triage] Could not load recorded failures');
        return null;
      })
    : [];
  // A failed read cannot establish absence or safely supersede a prior decision.
  if (!failures) return null;
  const failure = failures[0];
  const action = recommendDlqAction({
    ...entry,
    replay: 'replay' in entry ? entry.replay : undefined,
    messageId,
    queueLabel,
    failure,
  });
  const evidence = buildDlqTriageEvidence({
    ...facts,
    failure,
    owner: entry.owner,
    logFallback: failure
      ? { status: 'not-needed', sampledEvents: 0 }
      : await sampleDlqConsumerLogs(facts.sourceQueueUrl, messageId, facts.sentTimestamp, facts.logFallbackDeadline),
  });
  const key = {
    feature: 'dlqTriage' as const,
    entityId: dlqTriageEntityId(queueLabel, messageId),
    policyVersion: DLQ_TRIAGE_POLICY_VERSION,
    inputHash: decisionHash(action.action, {
      ...evidence,
      sentTimestamp: facts.sentTimestamp ?? null,
      retentionSeconds: facts.retentionSeconds ?? null,
    }),
  };
  let existing = await adminAiSuggestionRepository.findByKey(key);
  if (!existing) {
    const latest = await adminAiSuggestionRepository.findLatestForEntity(key.feature, key.entityId);
    const proposed = latest?.proposedAction;
    if (
      latest?.policyVersion === key.policyVersion &&
      proposed &&
      typeof proposed === 'object' &&
      'facts' in proposed
    ) {
      const previous = dlqTriageEvidenceSchema.safeParse(proposed.facts);
      // The draft preview stored hashes containing volatile evidence. Keep its matching decisions and delivery IDs.
      if (
        previous.success &&
        latest.verdict === action.action &&
        decisionHash(latest.verdict, previous.data) === key.inputHash
      ) {
        existing = latest;
      }
    }
  }
  const suggestion =
    existing ??
    (await adminAiSuggestionRepository.createPending({
      ...key,
      entityType: 'dead-letter',
      model: 'recorded-facts',
      actionClass: action.risk,
      verdict: action.action,
      confidence: { band: 'high', probability: 1 },
      reasons: [{ text: action.reason, evidenceLinks: facts.logsUrl ? [facts.logsUrl] : [] }],
      proposedAction: { ...action, facts: evidence },
      costUsd: 0,
      latencyMs: Date.now() - startedAt.getTime(),
    }));
  await recordAdminAiAttempt({
    feature: 'dlqTriage',
    policyVersion: DLQ_TRIAGE_POLICY_VERSION,
    outcome: existing ? 'cached' : 'suggestion',
    suggestionId: suggestion.id,
    calls: 0,
    knownCostUsd: 0,
    costUnknown: false,
    startedAt,
    finishedAt: new Date(),
  });
  return visibleDlqSuggestion(queueLabel, messageId);
}
