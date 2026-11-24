import { emailSendAttemptRepository, imageModerationIncidentRepository } from '@bike4mind/database';
import type { EmailDeliveryOutcome } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { reconcileEmailJob } from '../../email/reconcileEmailJob';
import type { EmailDeliveryRef } from '../eventBus';

/**
 * Writes a send's outcome back to what it was sent for. Never throws: the mail has already gone
 * (or failed), and a throw from the email-send worker would make EventBridge send it again.
 */
export async function recordEmailDeliveryOutcome(ref: EmailDeliveryRef, outcome: EmailDeliveryOutcome): Promise<void> {
  try {
    if (ref.kind === 'emailAttempt') {
      const jobId = await emailSendAttemptRepository.recordDeliveryOutcome(ref.attemptId, outcome);
      if (jobId) await reconcileEmailJob(jobId);
    } else {
      await imageModerationIncidentRepository.recordAlertDelivery(ref.incidentId, ref.alert, outcome);
    }
  } catch (e: unknown) {
    const id = ref.kind === 'emailAttempt' ? ref.attemptId : ref.incidentId;
    Logger.error(`Delivery outcome not recorded for ${ref.kind} ${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Voids an incident alert round that could not be queued for every reviewer. Never throws. */
export async function voidIncidentAlertRound(ref: EmailDeliveryRef, roundStart: Date): Promise<void> {
  if (ref.kind !== 'incidentAlert') return;
  try {
    await imageModerationIncidentRepository.voidAlertRound(ref.incidentId, ref.alert, roundStart);
  } catch (e: unknown) {
    Logger.error(
      `Alert round not voided for incident ${ref.incidentId}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
