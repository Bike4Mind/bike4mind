import {
  BILLING_ORGANIZATION_MISMATCH_ERROR_CODE,
  BadRequestError,
  CreditHolderType,
  NotFoundError,
  UnauthorizedError,
  type CompletionRunAttribution,
} from '@bike4mind/common';
import type { ApiKeyHolder } from '@bike4mind/server-utils/billing/assertApiKeyOrgMembership';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { apiKeyBillingOrgId, resolveApiKeyBillingOrg } from '@server/billing/apiKeyBillingOrg';
import { findCallerCompletionRun, resolveCompletionRunCaller } from './callerCompletionRun';

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

type PaidCallRequest = {
  user?: ApiKeyHolder;
  apiKeyInfo?: Pick<Express.ApiKeyInfo, 'billingOwnerType' | 'organizationId' | 'scopes'>;
};

/**
 * Resolve the `run` a paid route (image, video, music, speech, sound) was sent with. Same ownership
 * rule as completions (sseRoute.verifyRunOwnership): another caller's run is a 404, never a charge
 * against it. `requestedOrganizationId` is the route's own payer field; naming an account other than
 * the run's is refused rather than silently billing one of the two. An org-billed API key also passes
 * the key rule a run-less call gets from resolveMediaBillingOrgId (apiKeyBillingOrg.ts), so a key whose
 * org is gone or whose holder has left it is refused rather than billing the run's org.
 */
export async function resolvePaidCallRun(
  req: PaidCallRequest,
  run: CompletionRunAttribution | undefined,
  requestedOrganizationId?: string | null
): Promise<PaidCallRun | undefined> {
  if (!run) return undefined;
  if (!req.user) throw new UnauthorizedError('Sign in to charge a call to a completion run');
  const stored = await findPaidCallRun(run.runId, req.user.id, req.apiKeyInfo, requestedOrganizationId);
  const billingOrganizationId = stored.ownerType === CreditHolderType.Organization ? stored.ownerId : null;
  if (requestedOrganizationId !== undefined && requestedOrganizationId !== billingOrganizationId) {
    throw new ForbiddenError('This run bills a different account than the requested organization_id', {
      errorCode: BILLING_ORGANIZATION_MISMATCH_ERROR_CODE,
    });
  }
  const keyBilling = await resolveApiKeyBillingOrg({
    apiKeyInfo: req.apiKeyInfo,
    user: req.user,
    requestedOrgId: billingOrganizationId,
  });
  if (keyBilling.kind === 'stale') throw new BadRequestError(keyBilling.message);
  if (keyBilling.kind === 'mismatch') {
    throw new ForbiddenError(keyBilling.message, { errorCode: BILLING_ORGANIZATION_MISMATCH_ERROR_CODE });
  }
  return { attribution: { ...run, runId: stored.runId, purpose: 'tool' }, billingOrganizationId };
}

/**
 * The caller's run: first under the user (or an org-billed key's org), then, for a caller that is not an
 * org-billed key and names an organization, under that organization once resolveCompletionBillingOrgId
 * confirms the caller may use it (403 otherwise). A run minted with `organization_id` is bound to that
 * org, so a signed-in caller only finds it this way.
 */
async function findPaidCallRun(
  runId: string,
  userId: string,
  apiKeyInfo: PaidCallRequest['apiKeyInfo'],
  requestedOrganizationId: string | null | undefined
) {
  try {
    return await findCallerCompletionRun(runId, {
      userId,
      billingOrganizationId: apiKeyInfo?.organizationId ?? undefined,
    });
  } catch (error) {
    if (!(error instanceof NotFoundError) || apiKeyBillingOrgId(apiKeyInfo) || !requestedOrganizationId) throw error;
    const caller = await resolveCompletionRunCaller({ userId, apiKeyInfo }, requestedOrganizationId);
    return findCallerCompletionRun(runId, caller);
  }
}
