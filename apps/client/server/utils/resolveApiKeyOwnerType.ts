import { CreditHolderType, type ApiKeyBillingOwnerType } from '@bike4mind/common';

/** An API key bills its organization only when it is org-billed and actually carries an organization id. */
export const resolveApiKeyOwnerType = ({
  billingOwnerType,
  organizationId,
}: {
  billingOwnerType?: ApiKeyBillingOwnerType;
  organizationId?: string | null;
}): ApiKeyBillingOwnerType =>
  billingOwnerType === CreditHolderType.Organization && organizationId
    ? CreditHolderType.Organization
    : CreditHolderType.User;
