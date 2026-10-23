import {
  BILLING_ORGANIZATION_MISMATCH_ERROR_CODE,
  BadRequestError,
  CreditHolderType,
  ForbiddenError,
  type IUserDocument,
} from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';
import {
  API_KEY_DEPARTED_HOLDER_MESSAGE,
  isApiKeyOrgMembershipStale,
} from '@bike4mind/server-utils/billing/assertApiKeyOrgMembership';
import { resolveBillingOrgId } from '@bike4mind/server-utils/utils/orgAccess';
import { resolveApiKeyOwnerType } from '@server/utils/resolveApiKeyOwnerType';
import type { Request } from 'express';

type ApiKeyBillingFields = Pick<Express.ApiKeyInfo, 'billingOwnerType' | 'organizationId'>;

type BillingRequest = Pick<Request, 'user' | 'logger'> & {
  apiKeyInfo?: ApiKeyBillingFields;
};

/**
 * Where an API key's own billing target sends a request:
 * - `not_org_billed`: no key, or a user-billed key; the caller applies its route's usual rules.
 * - `org`: the key's organization pays.
 * - `mismatch`: the request named a different payer (`null` included) than the org-billed key's org.
 * - `stale`: the key's org is gone, or its holder is no longer a member (assertApiKeyOrgMembership).
 */
export type ApiKeyBillingOrg =
  | { kind: 'not_org_billed' }
  | { kind: 'org'; organizationId: string }
  | { kind: 'mismatch'; message: string }
  | { kind: 'stale'; message: string };

const MISMATCH_MESSAGE =
  "This API key bills its own organization; omit the billing organization or set it to the key's.";
const MISSING_ORG_MESSAGE = 'This API key bills an organization that no longer exists. Re-mint the key to continue.';

/** The organization an org-billed API key bills, or null for no key / a user-billed key. */
export function apiKeyBillingOrgId(apiKeyInfo: ApiKeyBillingFields | undefined): string | null {
  if (!apiKeyInfo || resolveApiKeyOwnerType(apiKeyInfo) !== CreditHolderType.Organization) return null;
  return apiKeyInfo.organizationId ?? null;
}

/**
 * The non-throwing core of the key rule, for callers that report failures as values rather than HTTP
 * errors (startAgentExecution serves both REST and WebSocket).
 */
export async function resolveApiKeyBillingOrg({
  apiKeyInfo,
  user,
  requestedOrgId,
}: {
  apiKeyInfo: ApiKeyBillingFields | undefined;
  user: Pick<IUserDocument, 'id' | 'isAdmin'>;
  requestedOrgId: string | null | undefined;
}): Promise<ApiKeyBillingOrg> {
  const keyOrgId = apiKeyBillingOrgId(apiKeyInfo);
  if (!keyOrgId) return { kind: 'not_org_billed' };

  if (requestedOrgId !== undefined && requestedOrgId !== keyOrgId) {
    return { kind: 'mismatch', message: MISMATCH_MESSAGE };
  }

  const keyOrg = await organizationRepository.findById(keyOrgId);
  if (!keyOrg) return { kind: 'stale', message: MISSING_ORG_MESSAGE };
  if (isApiKeyOrgMembershipStale({ billingOrg: keyOrg, billingUser: user, isApiKeyCaller: true })) {
    return { kind: 'stale', message: API_KEY_DEPARTED_HOLDER_MESSAGE };
  }
  return { kind: 'org', organizationId: keyOrgId };
}

/**
 * The organization a request bills, or null for personal credits. The v1 media create routes and
 * `/api/ai/llm` use it (under the media routes' name, resolveMediaBillingOrgId).
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
export async function resolveRequestBillingOrgId(
  req: BillingRequest,
  requestedOrgId: string | null | undefined
): Promise<string | null> {
  if (!apiKeyBillingOrgId(req.apiKeyInfo)) {
    return resolveBillingOrgId(req, requestedOrgId);
  }

  if (!req.user) throw new BadRequestError('User not found');
  const billing = await resolveApiKeyBillingOrg({ apiKeyInfo: req.apiKeyInfo, user: req.user, requestedOrgId });
  switch (billing.kind) {
    case 'org':
      return billing.organizationId;
    case 'mismatch':
      throw new ForbiddenError(billing.message, { errorCode: BILLING_ORGANIZATION_MISMATCH_ERROR_CODE });
    case 'stale':
      throw new BadRequestError(billing.message);
    case 'not_org_billed':
      // The guard above already sent these down resolveBillingOrgId's path.
      throw new Error('resolveRequestBillingOrgId: not_org_billed handled before the key rule');
  }
}
