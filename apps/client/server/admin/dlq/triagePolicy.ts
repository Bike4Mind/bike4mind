import { z } from 'zod';
import type { IDlqFailure } from '@bike4mind/database';

export const triageActionSchema = z.object({
  queueLabel: z.string().min(1),
  messageId: z.string().min(1),
  action: z.enum(['replay', 'discard', 'investigate']),
  risk: z.enum(['terminal-refusal', 'safe-transient', 'review-required']),
  reason: z.string().min(1),
});
export type TriageAction = z.infer<typeof triageActionSchema>;

export function recommendDlqAction(input: {
  queueLabel: string;
  messageId: string;
  replay?: 'safe' | 'side-effects' | 'unsafe';
  sourceQueue: string | null;
  failure?: IDlqFailure;
}): TriageAction {
  const identity = { queueLabel: input.queueLabel, messageId: input.messageId };
  if (input.failure?.terminalRefusal === true)
    return {
      ...identity,
      action: 'discard',
      risk: 'terminal-refusal',
      reason:
        'A recorded account, credit or spend-gate refusal prevents this job from running. Discard the dead letter; new work requires the gate to be cleared.',
    };
  if (input.failure?.transientFailure === true && input.replay === 'safe' && input.sourceQueue)
    return {
      ...identity,
      action: 'replay',
      risk: 'safe-transient',
      reason:
        'The consumer recorded a transient service failure and this queue is replay-safe. Retry once; any further failure needs an admin.',
    };
  return {
    ...identity,
    action: 'investigate',
    risk: 'review-required',
    reason: !input.failure
      ? 'No recorded failure is available. Inspect the consumer logs before choosing replay or discard.'
      : input.replay !== 'safe' || !input.sourceQueue
        ? 'Replay safety is not established for this queue. Review the failure and side effects before any action.'
        : 'The recorded failure is not a trusted terminal refusal or transient service failure. Investigate the consumer and confirm a fix before replay.',
  };
}

export const DLQ_TRIAGE_POLICY_VERSION = 'recommend-v1';
