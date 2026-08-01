import {
  IGroupRepository,
  IOrganizationRepository,
  IUserDocument,
  getGroupType,
  isKnownGroupType,
} from '@bike4mind/common';
import { resolveGroupTypesForUser } from './resolveGroupTypesForUser';

interface CapabilityAdapters {
  db: {
    organizations: Pick<IOrganizationRepository, 'findById'>;
    groups: Pick<IGroupRepository, 'findByOrganization'>;
  };
}

type CapabilityUser = Pick<IUserDocument, 'id' | 'groups'>;

/**
 * Resolve the CAPABILITY set a user holds within an organization (org-groups #1234).
 *
 * `GroupTypeDefinition.capabilities` is the product-behaviour axis a group type confers; until this
 * layer, holding a type conferred nothing beyond document ACL sharing. A user's capabilities are the
 * UNION of what each of their group types confers (decided #1234): most-permissive-wins, and
 * monotonic - adding a group never removes access. Group assignment is already authority-gated
 * (`assertCanManageOrgGroups`) and audited, so a mis-assignment over-granting is acceptable and
 * debuggable, unlike a ceiling that would silently clamp.
 *
 * Fail-closed: a user in no group (and not the billing owner) resolves to the EMPTY set - never a
 * default grant. A missing or soft-deleted org (findById -> null) is likewise empty.
 *
 * Billing-owner exception (decided #1226; lives HERE, not in the membership invariant): the owner is
 * never a `users[]` row, so the group write-path invariant can never assign them to a group and they
 * would otherwise be locked out of their own org's capabilities. `organization.userId === user.id`
 * implicitly holds every type the org is GRANTED (`allowedGroupTypes`) - not the whole catalog. This
 * is a resolution-layer read only; it does NOT relax `groupMembership.ts` invariant (2) (#1227/#1231).
 *
 * Keys stay generic (never a customer name) per GROUP_TYPE_CATALOG - product-specific keys live in
 * the consuming overlay. Returns a sorted, de-duplicated array (a serialisable shape for a client seam).
 */
export async function resolveCapabilitiesForUser(
  { user, organizationId }: { user: CapabilityUser; organizationId: string },
  adapters: CapabilityAdapters
): Promise<string[]> {
  const organization = await adapters.db.organizations.findById(organizationId);
  if (!organization) return [];

  const effectiveTypes = new Set(
    await resolveGroupTypesForUser({ user, organizationId }, { db: { groups: adapters.db.groups } })
  );

  // Billing-owner implicit hold: every GRANTED type (allowedGroupTypes), not the whole catalog.
  if (organization.userId === user.id) {
    for (const type of organization.allowedGroupTypes ?? []) {
      if (isKnownGroupType(type)) effectiveTypes.add(type);
    }
  }

  const capabilities = new Set<string>();
  for (const type of effectiveTypes) {
    for (const capability of getGroupType(type)?.capabilities ?? []) {
      capabilities.add(capability);
    }
  }
  return [...capabilities].sort();
}

/**
 * Server-side capability gate - the stable seam a consumer calls to key behaviour off group
 * membership. Thin boolean wrapper over `resolveCapabilitiesForUser` so call sites read as an
 * authorization check rather than an array-membership test.
 */
export async function userHasCapability(
  { user, organizationId, capability }: { user: CapabilityUser; organizationId: string; capability: string },
  adapters: CapabilityAdapters
): Promise<boolean> {
  const capabilities = await resolveCapabilitiesForUser({ user, organizationId }, adapters);
  return capabilities.includes(capability);
}
