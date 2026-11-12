import { createHash } from 'node:crypto';
import { AdminAiConfigSchema, type AdminAiSuggestionItem } from '@bike4mind/common';
import { adminAiSuggestionRepository, adminSettingsRepository, dlqFailureRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { getDlqByLabel, getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { getAdminAiClassReadiness } from '@server/admin/ai/readiness';
import { recordAdminAiAttempt } from '@server/admin/ai/telemetry';
import { DLQ_TRIAGE_POLICY_VERSION, recommendDlqAction } from './triagePolicy';

export const dlqTriageEntityId = (queueLabel: string, messageId: string) => `${queueLabel}:${messageId}`;

export async function loadDlqTriageConfig() {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    {
      names: ['adminAiConfig'],
      skipCache: true,
    }
  );
  return AdminAiConfigSchema.parse(getSettingsValue('adminAiConfig', settings, AdminAiConfigSchema.parse({})));
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
  return readiness.canRecommend ? suggestion : null;
}

export async function triageDlqMessage(
  queueLabel: string,
  messageId: string,
  facts: {
    sentTimestamp?: string;
    retentionSeconds?: number;
    logsUrl?: string | null;
    sourceQueueName?: string | null;
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
  const [failure] = sourceName ? await dlqFailureRepository.findForMessages(sourceName, [messageId]) : [];
  const action = recommendDlqAction({
    ...entry,
    replay: 'replay' in entry ? entry.replay : undefined,
    messageId,
    queueLabel,
    failure,
  });
  const evidence = {
    failureCategory: failure?.category ?? 'unknown',
    consumerVersion: failure?.consumerVersion ?? 'unknown',
    failedAt: failure?.failedAt.toISOString() ?? null,
    sentTimestamp: facts.sentTimestamp ?? null,
    retentionSeconds: facts.retentionSeconds ?? null,
    action,
  };
  const key = {
    feature: 'dlqTriage' as const,
    entityId: dlqTriageEntityId(queueLabel, messageId),
    policyVersion: DLQ_TRIAGE_POLICY_VERSION,
    inputHash: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
  };
  const existing = await adminAiSuggestionRepository.findByKey(key);
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
