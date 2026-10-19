import { BILLING_ORGANIZATION_MISMATCH_ERROR_CODE, CreditHolderType } from '@bike4mind/common';
import { ForbiddenError } from '@server/utils/errors';
import { resolveApiKeyOwnerType } from '@server/utils/resolveApiKeyOwnerType';
import { resolveMediaBillingOrgId } from './resolveMediaBillingOrgId';

type AudioBillingRequest = Parameters<typeof resolveMediaBillingOrgId>[0];
type OmittedBills = 'home-org' | 'user';

/**
 * The payer a sound-effects / speech request bills: `null` is the user, a string is the org pool.
 * `undefined` means a user-billed API key, so the route bills the user.
 *
 * A JWT caller's explicit and omitted values follow resolveMediaBillingOrgId, except that a route whose
 * historical default was the user (`omittedBills: 'user'`, TTS) keeps billing the user when the field is
 * omitted - the Switcher fix must not move the payer for callers that send nothing.
 *
 * A key cannot be re-targeted: an org-billed key bills its own organization (existence and roster
 * re-checked by resolveMediaBillingOrgId), and any other `organization_id` is a 403.
 */
export async function resolveAudioBillingOrgId(
  req: AudioBillingRequest,
  requestedOrgId: string | null | undefined,
  omittedBills: OmittedBills
): Promise<string | null | undefined> {
  if (!req.apiKeyInfo) {
    if (requestedOrgId === undefined && omittedBills === 'user') return null;
    return resolveMediaBillingOrgId(req, requestedOrgId);
  }

  const keyOrgId =
    resolveApiKeyOwnerType(req.apiKeyInfo) === CreditHolderType.Organization
      ? (req.apiKeyInfo.organizationId ?? undefined)
      : undefined;
  if (requestedOrgId !== undefined && requestedOrgId !== (keyOrgId ?? null)) {
    throw new ForbiddenError('This API key bills a different account than the requested organization_id', {
      errorCode: BILLING_ORGANIZATION_MISMATCH_ERROR_CODE,
    });
  }
  if (!keyOrgId) return undefined;

  return resolveMediaBillingOrgId(req, keyOrgId);
}
