export const DLQ_MAX_REPLAY_ATTEMPTS = 3;
// The longest a failed run can take to reach its DLQ: EventBridge retries a rule target for up to 24 hours
// (Lambda's own async retries stop within 6).
export const DLQ_NEXT_RUN_SETTLE_MS = 24 * 60 * 60_000;

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
  /** Registry flag for a queue whose dead letters go stale; must stay in sync with DlqStaleWhen in server-utils dlqRegistry. */
  staleWhen?: 'superseded-schedule' | 'self-healing';
  /** ISO time the dead-lettered scheduled run was for. */
  scheduledAt?: string;
  /** ISO time the following run was due; set only while the schedule rule is enabled and that run is not in the DLQ. */
  nextRunDueAt?: string;
  now?: number;
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
  if (facts.staleWhen === 'self-healing') {
    return {
      action: 'discard',
      label: 'Job obsolete, discard',
      basis: 'Retried by normal use: the consumer redoes this work on its own until it succeeds.',
    };
  }
  if (facts.staleWhen === 'superseded-schedule' && facts.scheduledAt && facts.nextRunDueAt) {
    const nextDue = Date.parse(facts.nextRunDueAt);
    if (Number.isFinite(nextDue) && nextDue + DLQ_NEXT_RUN_SETTLE_MS < (facts.now ?? Date.now())) {
      return {
        action: 'discard',
        label: 'Job obsolete, discard',
        basis: `Scheduled run at ${facts.scheduledAt}; the next run, due at ${facts.nextRunDueAt}, is not in this dead-letter queue a day later. Each run processes current state.`,
      };
    }
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
