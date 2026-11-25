import { organizationRepository } from '@bike4mind/database/infra';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

type AuditableRequest = Parameters<typeof recordAdminActionFromRequest>[0] & {
  user?: { id: string; isAdmin?: boolean };
};

/** `id` may be a Mongoose ObjectId; it is compared and recorded as a string. */
type ReadOrganization = { id: string | { toString(): string }; name?: string };

/**
 * The read surface an entry is recorded against, stored as `details.view` and filtered on there.
 * A union rather than a free string so a new call site cannot coin a second spelling of a label
 * that already exists and silently split an audit query over both.
 */
export type OrgReadView =
  | 'list'
  | 'detail'
  | 'member_activity'
  | 'stats'
  | 'roster'
  | 'storage_usage'
  | 'api_keys'
  | 'api_key_options'
  | 'member_api_keys';

/**
 * Records a platform admin's read of organizations they do not belong to in AdminAuditLog
 * (`org.viewed`), awaited before the data is served: the catalogue entry is strict, so a failed write
 * fails the read. Membership is `findMembershipOrgIds` (owner or a read/write ACL row); an org the
 * admin reaches only through a group or as a manager is still recorded, erring toward over-auditing.
 *
 * Keyed on the request user's own `isAdmin`. Under impersonation that is the impersonated account,
 * and every calling route already scopes a non-admin to its own orgs, so there is nothing to record.
 *
 * One entry per organization, targeting it, so a `target.kind`/`target.id` filter in the admin Audit
 * Log finds list and stats reads too. Platform-scoped by design: nothing here writes to
 * OrganizationAuditEventModel, so these never reach the tenant-facing org audit view
 * (GET /api/organizations/[id]/audit).
 */
export async function recordOrganizationRead(
  req: AuditableRequest,
  organizations: readonly ReadOrganization[],
  details: { view?: OrgReadView } & Record<string, unknown> = {}
): Promise<void> {
  const reader = req.user;
  if (!reader?.isAdmin || organizations.length === 0) return;

  const memberOrgIds = new Set(await organizationRepository.findMembershipOrgIds(reader.id));
  const unrelated = organizations
    .map(organization => ({ id: String(organization.id), name: organization.name || String(organization.id) }))
    .filter(organization => !memberOrgIds.has(organization.id));

  await Promise.all(
    unrelated.map(({ id, name }) =>
      recordAdminActionFromRequest(req, {
        action: 'org.viewed',
        target: { kind: 'organization', id, displayName: name },
        organizationId: id,
        summary: `viewed organization ${name}`,
        details,
      })
    )
  );
}
