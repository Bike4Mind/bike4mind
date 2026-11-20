/**
 * Literal-data contribution contracts for premium overlays (`b4mContributions` in an overlay's
 * package.json). The rest of the contract lives in apps/client/app/premiumContract.ts, which
 * re-exports these; they live here because the server and workers read them too.
 */

/**
 * Entitlement registry rows an overlay adds (`b4mContributions.entitlementGrants`) to the built-in
 * rows in server-utils' lib/entitlements/registry.ts, in new territory only: a row that changes a
 * built-in tag, implication or credit amount, or grants a key core already grants, is dropped.
 * Literal data, so the client bundle never imports overlay code. Keys and tags arrive normalized
 * (lowercase); `base`, `datalake:` and `embed:` keys and `source:` tags are reserved. An implication
 * must start from a key a contribution grants, and signup credits sit on contributed staff keys. Two
 * overlays giving one id different values, or one key two granting tags, fail the build.
 */
export interface PremiumEntitlementGrants {
  readonly tagGrants?: readonly { readonly tag: string; readonly entitlements: readonly string[] }[];
  readonly impliedEntitlements?: readonly { readonly ifHeld: string; readonly alsoGrant: readonly string[] }[];
  readonly signupCredits?: readonly { readonly key: string; readonly credits: number }[];
  /** Keys conferred on internal staff domains, on top of the built-in set. */
  readonly internalStaffEntitlements?: readonly string[];
}

/**
 * An API-key scope an overlay adds (`b4mContributions.apiKeyScopes`) to the built-in catalog in
 * server-utils' app/constants/apiKeyScopes.ts. Literal data, so the client bundle never imports
 * overlay code. The value is `<resource>:<action>`; the `admin`, `cc-bridge`, `embed` and `datalake` resources are reserved.
 * A contributed scope is never confined and is always self-mintable: the contract has no field for
 * either. With `requiredEntitlement` set, the scope is offered to a user holding that key, and to
 * every admin and developer-tagged user regardless (the bypass in isApiKeyScopeOffered, wider than
 * requestHasEntitlement's admin-only one), so a route serving a paid feature must also check the
 * entitlement itself. Two overlays giving one value different rows fail the build; an identical
 * repeat collapses.
 */
export interface PremiumApiKeyScope {
  readonly value: string;
  readonly label: string;
  readonly description: string;
  /** `METHOD /path` lines shown in the scope docs; informational, never used for routing. */
  readonly endpoints: readonly string[];
  readonly requiredEntitlement?: string;
}
