import { BILLING_ORGANIZATION_MISMATCH_ERROR_CODE, ForbiddenError, UnauthorizedError } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { resolveActiveOrg } from '@bike4mind/server-utils/utils/resolveActiveOrg';
import { adminRoleWithheldFor, withholdAdminRole } from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import { MISMATCH_MESSAGE, apiKeyBillingOrgId } from './apiKeyBillingOrg';

type CompletionBillingApiKey = Pick<Express.ApiKeyInfo, 'billingOwnerType' | 'organizationId' | 'scopes'>;

/**
 * The organization whose credit pool pays for a completion (undefined = personal credits).
 *
 * Shared by the completions route (sseRoute) and the completion-run routes, so a run is bound to, and
 * later found under, the same payer its completions charge (callerCompletionRun.completionRunOwnerOf).
 *
 * An organization-billed API key always bills its own org; a requested organization naming any other
 * payer (null included) is a 403. A signed-in caller defaults to personal credits (no home-org
 * fallback, unlike the media routes) and may name an org, validated through resolveActiveOrg: a
 * caller who cannot use the named organization gets a 403. A key without `admin:*` names an org as its
 * owner without the admin role (withholdAdminRole), so it needs membership like anyone else. Runs before
 * any credit hold or model call.
 */
export async function resolveCompletionBillingOrgId({
  apiKeyInfo,
  requestedOrgId,
  userId,
}: {
  apiKeyInfo: CompletionBillingApiKey | undefined;
  requestedOrgId: string | null | undefined;
  userId: string;
}): Promise<string | undefined> {
  const keyOrgId = apiKeyBillingOrgId(apiKeyInfo);
  if (keyOrgId) {
    if (requestedOrgId !== undefined && requestedOrgId !== keyOrgId) {
      throw new ForbiddenError(MISMATCH_MESSAGE, { errorCode: BILLING_ORGANIZATION_MISMATCH_ERROR_CODE });
    }
    return keyOrgId;
  }
  if (!requestedOrgId) return apiKeyInfo?.organizationId;

  const caller = await userRepository.findById(userId);
  if (!caller) throw new UnauthorizedError('Authentication failed. Provide a valid API key or JWT token.');
  const user = adminRoleWithheldFor(apiKeyInfo) ? withholdAdminRole(caller) : caller;
  return resolveActiveOrg({ user }, requestedOrgId);
}
