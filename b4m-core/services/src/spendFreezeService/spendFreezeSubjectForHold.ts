import type { SpendFreezeSubject } from '@bike4mind/common';

/**
 * Who a hold spends as. An org-billed API key (key plus billing org) spends the organization's money, not its
 * creator's, so the creator's own freeze does not apply.
 */
export const spendFreezeSubjectForHold = (params: {
  userId: string;
  organizationId: string | null;
  apiKeyId?: string | null;
}): SpendFreezeSubject => ({
  userId: params.apiKeyId && params.organizationId ? null : params.userId,
  organizationId: params.organizationId,
  apiKeyId: params.apiKeyId,
});
