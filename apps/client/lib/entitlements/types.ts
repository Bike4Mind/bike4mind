/**
 * Generic subscription -> entitlement layer - types.
 *
 * An entitlement key is an opaque, lowercase token (e.g. `<product>:pro`) that
 * gates access to a surface. Keys are granted three ways, resolved by the
 * registry (`./registry.ts`):
 *  - an active subscription whose Stripe priceId maps to the key,
 *  - a user tag (tags pass through as keys 1:1, plus comp-tag remap rows), or
 *  - the verified email's domain (domain-grant rows).
 *
 * This lib is isomorphic (client + server) - keep it free of `@server/*`
 * imports, mirroring `lib/subscriptions/`.
 */

/** Opaque entitlement token. Canonical form is lowercase. */
export type EntitlementKey = string;

/** Maps one Stripe price to the entitlement key(s) it grants. */
export interface PriceEntitlementRow {
  /** Exact Stripe price id for the deployed stage (`price_...`). */
  priceId: string;
  entitlements: EntitlementKey[];
}

/**
 * Remaps a comp/admin-granted user tag to paid entitlement key(s), on top of
 * the 1:1 tag->key passthrough (a tag is always also its own key).
 */
export interface TagGrantRow {
  tag: string;
  entitlements: EntitlementKey[];
}

/**
 * Grants entitlement key(s) to any user whose VERIFIED email is in the given
 * domain. Derive-on-read (no Stripe row, no signup-time write) - auto-covers
 * existing users and auto-revokes if the email changes. Gated on verified
 * email; the domain is the substring after the last `@`, normalized lowercase.
 */
export interface DomainGrantRow {
  domain: string;
  entitlements: EntitlementKey[];
}
