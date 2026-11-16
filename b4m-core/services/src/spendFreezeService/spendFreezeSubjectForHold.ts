import { CreditHolderType, type ApiKeyBillingOwnerType, type SpendFreezeSubject } from '@bike4mind/common';

/**
 * Who a hold spends as. Only an org-billed API key spends the organization's money rather than its creator's, so
 * only then is the creator left out. A user-billed key is checked as its owner even when the spend lands on an
 * organization (a home-org or passed organization_id fallback), and a key of unknown type is checked as the user.
 */
export const spendFreezeSubjectForHold = (params: {
  userId: string;
  organizationId: string | null;
  apiKeyId?: string | null;
  apiKeyBillingOwnerType?: ApiKeyBillingOwnerType | null;
}): SpendFreezeSubject => ({
  userId: params.apiKeyId && params.apiKeyBillingOwnerType === CreditHolderType.Organization ? null : params.userId,
  organizationId: params.organizationId,
  apiKeyId: params.apiKeyId,
});
