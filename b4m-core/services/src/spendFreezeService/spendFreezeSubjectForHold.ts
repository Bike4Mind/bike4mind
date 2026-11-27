import type { SpendFreezeSubject } from '@bike4mind/common';

/**
 * Who a hold spends as: the acting user, the organization billed and the key, for every key. An org-owned
 * key authenticates as the organization's service account, so its user is that account; keeping the user on
 * an org-billed key a person minted means a frozen user cannot spend through it.
 */
export const spendFreezeSubjectForHold = (params: {
  userId: string;
  organizationId: string | null;
  apiKeyId?: string | null;
}): SpendFreezeSubject => ({
  userId: params.userId,
  organizationId: params.organizationId,
  apiKeyId: params.apiKeyId,
});
