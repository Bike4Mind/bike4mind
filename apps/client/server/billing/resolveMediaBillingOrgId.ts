import { BILLING_ORGANIZATION_MISMATCH_ERROR_CODE, CreditHolderType } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { assertApiKeyOrgMembership } from '@server/billing/assertApiKeyOrgMembership';
import { resolveBillingOrgId } from '@server/utils/orgAccess';
import { resolveApiKeyOwnerType } from '@server/utils/resolveApiKeyOwnerType';
import type { Request } from 'express';

type MediaBillingRequest = Pick<Request, 'user' | 'logger'> & {
  apiKeyInfo?: Pick<Express.ApiKeyInfo, 'billingOwnerType' | 'organizationId'>;
};

/**
 * The organization a v1 media request (image generations, image edits, video and music generations)
 * bills, or null for personal credits.
 *
 * An org-billed API key follows the key, like chat (sseRoute/wsRoute), reserveRequestCredits and the
 * lake search's resolveBillingOrg: its org pays whether or not the body names one. A body
 * `organization_id` must then be that same org - anything else, `null` included, is a 403 rather than
 * a silent switch of payer. The key's org must still exist and still count the key's holder as a
 * member (assertApiKeyOrgMembership), so a departed holder fails closed instead of billing anyone.
 *
 * A user-billed key and a session caller keep resolveBillingOrgId's rules: the body's
 * `organization_id`, else the caller's home org.
 */
export async function resolveMediaBillingOrgId(
  req: MediaBillingRequest,
  requestedOrgId: string | null | undefined
): Promise<string | null> {
  const keyOrgId =
    req.apiKeyInfo && resolveApiKeyOwnerType(req.apiKeyInfo) === CreditHolderType.Organization
      ? req.apiKeyInfo.organizationId
      : undefined;
  if (!keyOrgId) {
    return resolveBillingOrgId(req, requestedOrgId);
  }

  if (requestedOrgId !== undefined && requestedOrgId !== keyOrgId) {
    throw new ForbiddenError(
      "This API key bills its own organization; omit the billing organization or set it to the key's.",
      { errorCode: BILLING_ORGANIZATION_MISMATCH_ERROR_CODE }
    );
  }

  if (!req.user) throw new BadRequestError('User not found');
  const keyOrg = await organizationRepository.findById(keyOrgId);
  if (!keyOrg) {
    throw new BadRequestError('This API key bills an organization that no longer exists. Re-mint the key to continue.');
  }
  assertApiKeyOrgMembership({ billingOrg: keyOrg, billingUser: req.user, isApiKeyCaller: true });
  return keyOrgId;
}
