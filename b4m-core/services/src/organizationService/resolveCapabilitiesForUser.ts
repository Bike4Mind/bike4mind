import {
  IGroupRepository,
  IOrganizationRepository,
  IUserDocument,
  getGroupType,
  isKnownGroupType,
} from '@bike4mind/common';
import {
  resolveGroupTypesForUser,
  isGroupTypeOverrideActive,
  type GroupTypeResolutionOverride,
} from './resolveGroupTypesForUser';

interface CapabilityAdapters {
  db: {
    organizations: Pick<IOrganizationRepository, 'findById'>;
    groups: Pick<IGroupRepository, 'findByOrganization'>;
  };
  /** Forwarded to the type resolver, which logs an applied override (#1236). */
  logger?: { info: (message: string) => void };
}

type CapabilityUser = Pick<IUserDocument, 'id' | 'groups'> & { isAdmin?: boolean };

/**
 * Group-type -> capability keys, injected by the consumer (org-groups #1178).
 *
 * `GROUP_TYPE_CATALOG` ships `capabilities` EMPTY in open core on purpose: what a type confers is
 * product-specific (e.g. `crm:read`) and a product key can't live in the generic public
 * catalog. The consuming overlay owns that mapping and passes it here; core stays generic and simply
 * resolves the union. A type absent from the map falls back to the catalog's own capabilities (empty
 * today), so omitting a type means it confers nothing. Code-defined and platform-controlled - never
 * org-writable, which is what keeps an org from granting itself a capability (#1178 decision).
 */
export type GroupTypeCapabilityMap = Readonly<Record<string, readonly string[]>>;

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
 * It does not apply under an active resolution override (#1236) - see the branch comment below.
 *
 * Keys stay generic (never a customer name) per GROUP_TYPE_CATALOG - product-specific keys live in
 * the consuming overlay. Returns a sorted, de-duplicated array (a serialisable shape for a client seam).
 */
export async function resolveCapabilitiesForUser(
  {
    user,
    organizationId,
    override,
    capabilitiesByType,
  }: {
    user: CapabilityUser;
    organizationId: string;
    override?: GroupTypeResolutionOverride;
    capabilitiesByType?: GroupTypeCapabilityMap;
  },
  adapters: CapabilityAdapters
): Promise<string[]> {
  const organization = await adapters.db.organizations.findById(organizationId);
  if (!organization) return [];

  // Forward the platform-admin override (#1236) so capabilities reflect the persona being operated as.
  const overridden = isGroupTypeOverrideActive(override, user, organizationId);
  const effectiveTypes = new Set(
    await resolveGroupTypesForUser(
      { user, organizationId, override },
      { db: { groups: adapters.db.groups }, logger: adapters.logger }
    )
  );

  // Billing-owner implicit hold: every GRANTED type (allowedGroupTypes), not the whole catalog.
  // SKIPPED under an active override: `isAdmin` (the override gate) and `organization.userId ===
  // user.id` (this branch) are independent, and an admin who created the demo org IS its userId - the
  // likely shape for this affordance. Unioned, the preview would report capabilities the persona does
  // not hold, a false positive in exactly the "does this persona see X?" check the override exists to
  // answer. The admin loses nothing: their own capabilities are what they resolve to without an
  // override, and the override is opt-in per call.
  if (!overridden && organization.userId === user.id) {
    for (const type of organization.allowedGroupTypes ?? []) {
      if (isKnownGroupType(type)) effectiveTypes.add(type);
    }
  }

  // Prefer the consumer-injected mapping (#1178); fall back to the catalog's own capabilities
  // (empty in open core). A type absent from the injected map contributes nothing.
  const capabilities = new Set<string>();
  for (const type of effectiveTypes) {
    for (const capability of capabilitiesByType?.[type] ?? getGroupType(type)?.capabilities ?? []) {
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
  {
    user,
    organizationId,
    capability,
    override,
    capabilitiesByType,
  }: {
    user: CapabilityUser;
    organizationId: string;
    capability: string;
    override?: GroupTypeResolutionOverride;
    capabilitiesByType?: GroupTypeCapabilityMap;
  },
  adapters: CapabilityAdapters
): Promise<boolean> {
  const capabilities = await resolveCapabilitiesForUser(
    { user, organizationId, override, capabilitiesByType },
    adapters
  );
  return capabilities.includes(capability);
}
