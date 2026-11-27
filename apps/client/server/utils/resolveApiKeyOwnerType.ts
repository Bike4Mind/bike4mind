import { CreditHolderType, type ApiKeyBillingOwnerType, type PayerStanding } from '@bike4mind/common';

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

/** The connected app and payer standing an exchange key stamps on its request log; empty for any other key. */
export const exchangeAttribution = ({
  oauthExchangeClientId,
  payerStanding,
}: {
  oauthExchangeClientId?: string;
  payerStanding?: PayerStanding;
}): { oauthClientId?: string; payerStanding?: PayerStanding } =>
  oauthExchangeClientId ? { oauthClientId: oauthExchangeClientId, ...(payerStanding ? { payerStanding } : {}) } : {};
