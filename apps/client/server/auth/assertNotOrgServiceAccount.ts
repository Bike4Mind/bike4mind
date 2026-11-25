import { isOrgServiceAccount } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';

/**
 * Refuses an organization's service account (common constants/orgServiceAccount.ts). It holds every
 * org-owned key of its org, so a request authenticated with one of those keys must not list, mint or
 * change keys "for itself": that would reach its sibling keys and bypass the org routes' audit.
 * Org-owned keys are managed only through pages/api/organizations/[id]/api-keys/*. Every route that
 * manages keys on behalf of req.user calls this first.
 */
export function assertNotOrgServiceAccount(
  user: { serviceAccountOrganizationId?: string | null } | null | undefined
): void {
  if (isOrgServiceAccount(user)) {
    throw new ForbiddenError('An organization API key cannot manage API keys');
  }
}
