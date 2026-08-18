/**
 * Platform-defined catalog of organization **group types** (org-groups epic #1172).
 *
 * Code-defined rather than a DB collection, mirroring the entitlement-key registry: admin
 * surfaces and grant routes source their options from this ONE place, so a typo can't persist
 * a dead grant. Adding a type costs a deploy, which is appropriate - types are product concepts,
 * not customer data.
 *
 * Keys MUST stay generic (never a customer name); a customer-specific type would be a guarded
 * token and could not live in open core.
 *
 * NOTE: `capabilities` is declared but has NO consumer yet (epic non-goal). How capabilities
 * resolve - and whether they union with entitlement keys - is a separate design. Store the
 * field; read it nowhere until that lands.
 */
export interface GroupTypeDefinition {
  /** Stable, generic key. The value stored on `Group.type` and in `Organization.allowedGroupTypes`. */
  key: string;
  /** Default `Group.name` at provision time. Org admins may rename the instance. */
  label: string;
  description: string;
  /** Scalar-conflict resolution for multi-group users. Lower wins. */
  priority: number;
  /**
   * Capability keys this type confers (e.g. `crm:read`). Unioned across a user's groups.
   * Optional/reserved: no consumer reads it yet (see the note above), so it is not part of the
   * contract - a type that omits it is valid.
   */
  capabilities?: string[];
}

// `key` stays a plain `string` (not a closed literal union): it is a persisted value read back
// from Mongo, and a type alias cannot be augmented by a private overlay without forcing
// overlay-specific keys into this public repo. No `as const` here - the `readonly
// GroupTypeDefinition[]` annotation already widens `key` to `string`, so `as const` bought nothing.
// Object.freeze (not `as const`): a runtime immutability guarantee for this shared singleton, since
// the `readonly GroupTypeDefinition[]` annotation is compile-time only and `as const` would widen
// away under it anyway (see the note above on why `key` stays `string`).
export const GROUP_TYPE_CATALOG: readonly GroupTypeDefinition[] = Object.freeze([
  {
    key: 'sales',
    label: 'Sales',
    description: 'Sales team members.',
    priority: 10,
  },
  {
    key: 'research',
    label: 'Research',
    description: 'Research team members.',
    priority: 20,
  },
  {
    key: 'customer',
    label: 'Customer',
    description: 'Customer-facing members.',
    priority: 30,
  },
]);

/** The set of valid group-type keys - the single source the grant route and UI validate against. */
export const KNOWN_GROUP_TYPE_KEYS: readonly string[] = GROUP_TYPE_CATALOG.map(t => t.key);

const CATALOG_BY_KEY = new Map<string, GroupTypeDefinition>(GROUP_TYPE_CATALOG.map(t => [t.key, t]));

/** The catalog entry for a key, or undefined if the key is not a known type. */
export const getGroupType = (key: string): GroupTypeDefinition | undefined => CATALOG_BY_KEY.get(key);

export const isKnownGroupType = (key: string): boolean => CATALOG_BY_KEY.has(key);

/** Keys in the input that the catalog does not recognize (for defense-in-depth validation on writes). */
export const unknownGroupTypeKeys = (keys: readonly string[]): string[] => keys.filter(key => !CATALOG_BY_KEY.has(key));
