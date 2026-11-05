import { addBlockedEmailDomains } from '@server/admin/blockedEmailDomains';
import { requestAuditWriter } from '@server/utils/adminAudit';

type AuditRequest = Parameters<typeof requestAuditWriter>[0];

/**
 * Adds a domain to the blockedEmailDomains setting so the registration gate refuses new signups on
 * it, for a bulk abuse response. Returns false when the domain was already listed (or a parent of it was).
 */
export async function addBlockedEmailDomain(req: AuditRequest, rawDomain: string): Promise<boolean> {
  const added = await addBlockedEmailDomains(
    requestAuditWriter(req),
    [rawDomain],
    ([domain]) => `blocked signups from ${domain} in a bulk abuse response`
  );
  return added.length > 0;
}
