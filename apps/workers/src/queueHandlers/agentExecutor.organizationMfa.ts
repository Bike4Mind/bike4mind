import type { IUserDocument } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { assertOrganizationMfa } from '@bike4mind/server-utils/auth/organizationMfa';

export async function assertExecutionOrganizationMfa(
  user: Pick<IUserDocument, 'id' | 'orgServiceAccount'>,
  session: { organizationId?: string | null },
  billingOrganizationId?: string | null
): Promise<void> {
  if (user.orgServiceAccount) throw new ForbiddenError('Service accounts require a resource-grant-aware REST endpoint');
  const organizationIds = new Set([session.organizationId, billingOrganizationId]);
  for (const organizationId of organizationIds) {
    if (organizationId) await assertOrganizationMfa(user.id, organizationId);
  }
}
