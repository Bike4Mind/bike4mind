export const DLQ_MAX_REPLAY_ATTEMPTS = 3;

export type DlqRecommendation = {
  action: 'replay' | 'discard' | 'fix-first' | 'inspect';
  label: string;
  basis: string;
};

export type DlqRecommendationFacts = {
  category?: string;
  errorType?: string;
  failedAt?: string;
  /** Lambda LastModified can describe a configuration update, not a code change. */
  consumerDeployedAt?: string;
  replayAttempts?: number;
  replaySafety?: string;
};

export const requiresDlqReplayReason = (safety: string | undefined): boolean => safety !== 'safe';

export function recommendDlqAction(facts: DlqRecommendationFacts): DlqRecommendation {
  const attempts =
    Number.isInteger(facts.replayAttempts) && (facts.replayAttempts ?? -1) >= 0 ? facts.replayAttempts : undefined;
  if (attempts !== undefined && attempts >= DLQ_MAX_REPLAY_ATTEMPTS) {
    return {
      action: 'discard',
      label: 'Discard',
      basis: `${facts.replayAttempts} recorded replay attempts; the limit is ${DLQ_MAX_REPLAY_ATTEMPTS}.`,
    };
  }
  if (facts.category === 'refused') {
    return {
      action: 'inspect',
      label: 'Inspect first',
      basis: 'A refusal can reflect access or configuration. Inspect the recorded error before deciding.',
    };
  }
  const transient =
    facts.category === 'timeout'
      ? 'timeout'
      : /^(ThrottlingException|TooManyRequestsException|Throttling|RequestThrottled|ServiceUnavailableException|DependencyFailedException)$/.test(
            facts.errorType ?? ''
          )
        ? facts.errorType
        : undefined;
  if (transient) {
    if (attempts === undefined)
      return {
        action: 'inspect',
        label: 'Inspect first',
        basis: 'Replay attempt count is unavailable. Check recorded attempts before replaying.',
      };
    if (facts.replaySafety !== 'safe')
      return {
        action: 'inspect',
        label: 'Inspect first',
        basis: 'Replay can have side effects or its safety is unknown. Inspect the consumer before replaying.',
      };
    return { action: 'replay', label: 'Replay', basis: `Recorded transient failure: ${transient}.` };
  }
  if (facts.category === 'invalid output' || facts.category === 'bug') {
    return {
      action: 'fix-first',
      label: 'Fix first',
      basis: `Recorded ${facts.category}; inspect and fix the consumer before replaying.`,
    };
  }
  const failedAt = Date.parse(facts.failedAt ?? '');
  const updatedAt = Date.parse(facts.consumerDeployedAt ?? '');
  if (Number.isFinite(failedAt) && Number.isFinite(updatedAt) && failedAt < updatedAt) {
    return {
      action: 'inspect',
      label: 'Consumer updated since failure',
      basis: `Consumer configuration was updated at ${facts.consumerDeployedAt} after the failure. Inspect the change; a code fix is not established.`,
    };
  }
  return {
    action: 'inspect',
    label: 'Inspect first',
    basis: 'Recorded facts do not establish a replay or discard recommendation.',
  };
}
