export const DLQ_MAX_REPLAY_ATTEMPTS = 3;

export type DlqRecommendation = {
  action: 'replay' | 'discard' | 'fix-first' | 'inspect';
  label: string;
  basis: string;
};

export interface DlqRecommendationFacts {
  category?: string;
  errorType?: string;
  failedAt?: string;
  consumerVersion?: string;
  runningConsumerVersion?: string;
  consumerDeployedAt?: string;
  replayAttempts?: number;
}

export const requiresDlqReplayReason = (safety: string | undefined): boolean => safety !== 'safe';

export function recommendDlqAction(facts: DlqRecommendationFacts): DlqRecommendation {
  if (facts.replayAttempts !== undefined && facts.replayAttempts >= DLQ_MAX_REPLAY_ATTEMPTS) {
    return {
      action: 'discard',
      label: 'Discard',
      basis: `${facts.replayAttempts} recorded replay attempts; the limit is ${DLQ_MAX_REPLAY_ATTEMPTS}.`,
    };
  }
  if (facts.category === 'refused') {
    return { action: 'discard', label: 'Discard', basis: 'The recorded failure category is refused.' };
  }
  if (
    facts.category === 'timeout' ||
    facts.category === 'throttle' ||
    facts.category === 'dependency' ||
    /^(ThrottlingException|TooManyRequestsException|Throttling|RequestThrottled|ServiceUnavailableException|DependencyFailedException)$/.test(
      facts.errorType ?? ''
    )
  ) {
    return {
      action: 'replay',
      label: 'Replay',
      basis: `Recorded transient failure: ${facts.errorType || facts.category}.`,
    };
  }
  const failedAt = Date.parse(facts.failedAt ?? '');
  const deployedAt = Date.parse(facts.consumerDeployedAt ?? '');
  if (Number.isFinite(failedAt) && Number.isFinite(deployedAt) && failedAt < deployedAt) {
    return {
      action: 'replay',
      label: 'Possibly fixed since: replay',
      basis: `The failure at ${facts.failedAt} predates the running consumer deployment at ${facts.consumerDeployedAt}.`,
    };
  }
  if (facts.category === 'invalid output' || facts.category === 'bug') {
    const sameVersion =
      facts.consumerVersion &&
      !['unknown', '$LATEST'].includes(facts.consumerVersion) &&
      facts.consumerVersion === facts.runningConsumerVersion;
    return {
      action: 'fix-first',
      label: 'Fix first',
      basis: sameVersion
        ? `Recorded ${facts.category}; consumer version ${facts.consumerVersion} is still running.`
        : `Recorded ${facts.category}; no newer consumer deployment is confirmed.`,
    };
  }
  return {
    action: 'inspect',
    label: 'Inspect first',
    basis: 'Recorded facts do not establish a replay or discard recommendation.',
  };
}
