import type { IOrganizationDocument, IUserDocument } from '@bike4mind/common';
import { organizationService } from '@bike4mind/services';
import { BadRequestError } from '@server/utils/errors';

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
export function assertApiKeyOrgMembership({
  billingOrg,
  billingUser,
  isApiKeyCaller,
}: {
  billingOrg: IOrganizationDocument | null;
  billingUser: Pick<IUserDocument, 'id' | 'isAdmin'>;
  isApiKeyCaller: boolean;
}): void {
  if (
    billingOrg &&
    isApiKeyCaller &&
    !billingUser.isAdmin &&
    !organizationService.isCurrentOrgMember(billingOrg, billingUser.id)
  ) {
    throw new BadRequestError(
      'This API key bills an organization you are no longer a member of. Re-mint the key to continue.'
    );
  }
}
