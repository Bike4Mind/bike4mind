import type { IOrganizationDocument, IUserDocument } from '@bike4mind/common';
import { organizationService } from '@bike4mind/services';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { persistedIsAdmin } from '@server/auth/apiKeyAdminScope';

export const API_KEY_DEPARTED_HOLDER_MESSAGE =
  'This API key bills an organization you are no longer a member of. Re-mint the key to continue.';

type ApiKeyOrgMembershipInput = {
  billingOrg: IOrganizationDocument | null;
  billingUser: Pick<IUserDocument, 'id' | 'isAdmin'>;
  isApiKeyCaller: boolean;
};

/** The predicate behind assertApiKeyOrgMembership, for callers that report the failure as a value. */
export function isApiKeyOrgMembershipStale({
  billingOrg,
  billingUser,
  isApiKeyCaller,
}: ApiKeyOrgMembershipInput): boolean {
  return (
    !!billingOrg &&
    isApiKeyCaller &&
    !persistedIsAdmin(billingUser) &&
    !organizationService.isCurrentOrgMember(billingOrg, billingUser.id)
  );
}

/**
 * Fail closed when an org-billed API key's holder is no longer on the org it bills.
 *
 * Mint-time trust is not use-time trust: an org-billed key carries its billing target stamped on it
 * and never revisited, so a key whose minting user has since left the org would keep drawing on that
 * org's shared pool. Scoped to the API-key path only: that caller asked for org billing explicitly,
 * whereas the implicit JWT own-org fallback must degrade rather than refuse a caller on a stale
 * pointer. executeCompletion (b4m-core/services/src/cliCompletions.ts) applies the same rule on the
 * completions path but throws a plain Error, so keep the two rules in step when either changes.
 *
 * A platform admin mints org-billed keys on a customer org's behalf (user-api-keys/index.ts admits
 * them explicitly) and is never on that org's roster, so the authority arm is checked here rather
 * than inside isCurrentOrgMember, which reports roster attachment only.
 */
export function assertApiKeyOrgMembership(input: ApiKeyOrgMembershipInput): void {
  if (isApiKeyOrgMembershipStale(input)) {
    throw new BadRequestError(API_KEY_DEPARTED_HOLDER_MESSAGE);
  }
}
