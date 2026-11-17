import {
  BILLING_ORGANIZATION_MISMATCH_ERROR_CODE,
  CreditHolderType,
  type CompletionRunAttribution,
} from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { findCallerCompletionRun } from './callerCompletionRun';

/** A paid tool call's run, once the caller is confirmed to have minted it. */
export type PaidCallRun = {
  /** Claimed against and recorded on the ledger row: the stored run id, always purpose `tool`. */
  attribution: CompletionRunAttribution;
  /**
   * The account the run is bound to: its organization, or null for the user. The route bills this
   * account, so the charge lands where the run's usage read sums its settled spend
   * (CreditTransactionRepository.completionRunSpend matches the run's owner).
   */
  billingOrganizationId: string | null;
};

type PaidCallRequest = { user: { id: string }; apiKeyInfo?: { organizationId?: string | null } };

/**
 * Resolve the `run` a paid route (image, video, music, speech, sound) was sent with. Same ownership
 * rule as completions (sseRoute.verifyRunOwnership): another caller's run is a 404, never a charge
 * against it. `requestedOrganizationId` is the route's own payer field; naming an account other than
 * the run's is refused rather than silently billing one of the two.
 */
export async function resolvePaidCallRun(
  req: PaidCallRequest,
  run: CompletionRunAttribution | undefined,
  requestedOrganizationId?: string | null
): Promise<PaidCallRun | undefined> {
  if (!run) return undefined;
  const stored = await findCallerCompletionRun(run.runId, {
    userId: req.user.id,
    billingOrganizationId: req.apiKeyInfo?.organizationId ?? undefined,
  });
  const billingOrganizationId = stored.ownerType === CreditHolderType.Organization ? stored.ownerId : null;
  if (requestedOrganizationId !== undefined && requestedOrganizationId !== billingOrganizationId) {
    throw new ForbiddenError('This run bills a different account than the requested organization_id', {
      errorCode: BILLING_ORGANIZATION_MISMATCH_ERROR_CODE,
    });
  }
  return { attribution: { ...run, runId: stored.runId, purpose: 'tool' }, billingOrganizationId };
}
