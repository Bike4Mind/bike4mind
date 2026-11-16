import { CreditHolderType, type SpendFreezeSubject } from '@bike4mind/common';

/**
 * Who a request spends as, for the spend freeze check. An org-billed API key spends the organization's
 * money, so it carries the key and org but not its creator: a frozen creator must not stop the org's
 * integration. Every other caller carries the user.
 */
export function spendFreezeSubjectForRequest(
  req: {
    user?: { id: string };
    // Structural slice of Express.ApiKeyInfo, whose augmentation lives in apps/client/global.d.ts.
    apiKeyInfo?: { billingOwnerType?: CreditHolderType; keyId?: string };
  },
  billingOrganizationId: string | null
): SpendFreezeSubject {
  const orgBilledKey = req.apiKeyInfo?.billingOwnerType === CreditHolderType.Organization;
  return {
    userId: orgBilledKey ? null : (req.user?.id ?? null),
    organizationId: billingOrganizationId,
    apiKeyId: req.apiKeyInfo?.keyId ?? null,
  };
}

/**
 * The organization a request spends the money of, for the freeze check: only an org-billed API key's own
 * organization. Everyone else spends personally, so the user's home organization is never the subject.
 */
export function billedOrganizationIdForFreeze(
  apiKeyInfo: { billingOwnerType?: CreditHolderType; organizationId?: string | null } | undefined
): string | null {
  return apiKeyInfo?.billingOwnerType === CreditHolderType.Organization ? (apiKeyInfo.organizationId ?? null) : null;
}
