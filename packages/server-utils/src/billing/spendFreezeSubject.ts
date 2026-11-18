import { CreditHolderType, type SpendFreezeSubject } from '@bike4mind/common';

/**
 * Who a request spends as, for the spend freeze check: the acting user, the billing org and the key, for every
 * key. An org-owned key authenticates as the organization's service account, so its user is that account;
 * keeping the user on an org-billed key a person minted means a frozen user cannot spend through it.
 */
// Structural slice of Express.ApiKeyInfo, whose augmentation lives in apps/client/global.d.ts.
export type SpendFreezeApiKey = { keyId?: string };

export function spendFreezeSubjectForRequest(
  req: {
    user?: { id: string };
    apiKeyInfo?: SpendFreezeApiKey;
  },
  billingOrganizationId: string | null
): SpendFreezeSubject {
  return {
    userId: req.user?.id ?? null,
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
