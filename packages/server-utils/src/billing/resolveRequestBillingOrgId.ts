import { CreditHolderType, type IUserDocument } from '@bike4mind/common';

/**
 * The organization a request bills, or undefined when it bills the user. Precedence: org-billed API key
 * -> its org; user-billed API key -> the user; JWT caller -> `organizationId` when given (null = the
 * user), else the user's own org seat.
 */
export function resolveRequestBillingOrgId(
  req: {
    user?: Pick<IUserDocument, 'organizationId'>;
    apiKeyInfo?: Pick<Express.ApiKeyInfo, 'billingOwnerType' | 'organizationId'>;
  },
  organizationId?: string | null
): string | undefined {
  if (req.apiKeyInfo) {
    return req.apiKeyInfo.billingOwnerType === CreditHolderType.Organization
      ? req.apiKeyInfo.organizationId
      : undefined;
  }
  if (organizationId !== undefined) return organizationId ?? undefined;
  return req.user?.organizationId?.toString() ?? undefined;
}
