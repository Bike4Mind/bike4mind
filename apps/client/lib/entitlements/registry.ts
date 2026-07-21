/**
 * Generic subscription -> entitlement registry (ACCESS_MODEL.md §3).
 *
 * Pure config + pure helpers - the single source of truth for how Stripe
 * prices and user tags resolve to entitlement keys. A new product onboards by
 * adding rows here (no code): one PRICE row per Stripe price, optionally one
 * TAG_GRANTS row to remap its comp tag to the paid key.
 *
 * Boundary note: product-specific rows below (LibreOncology; OptiHashi) are
 * sanctioned cross-boundary data - this file is allowlisted in
 * scripts/libreoncology-core-allowlist.txt. External customer domain grants are
 * env-sourced (no customer identity in code). Rows marked
 * [DELETION-FOOTPRINT] are removed when their product is extracted. Do NOT
 * import constants from a product namespace into this file (wrong dependency
 * direction); keep the literals inline.
 */
import type { DomainGrantRow, EntitlementKey, PriceEntitlementRow, TagGrantRow } from './types';
import { isTestMode } from '@client/lib/subscriptions/constants';
import { parseInternalStaffDomains } from '@bike4mind/common';

/**
 * Canonical tag/key normalization - the ONE comparison rule for the
 * entitlement layer (tags are assumed ASCII; matches the existing
 * `requireFeatureTag` / `userHasLibreOncologyAccess` lowercase semantics).
 */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * Reserved universal entitlement key held by EVERY authenticated user (injected
 * in `getUserEntitlements`). It is the baseline-access signal that replaces the
 * old "stamp a `Customer` tag on every account" workaround: a model declaring
 * `allowedEntitlements: ['base']` is public to all authenticated users, while
 * `isModelAccessible` stays fail-closed for a genuinely ungated (empty tags AND
 * empty entitlements) config. Deliberately NOT a grant row / NOT in
 * `KNOWN_ENTITLEMENT_KEYS`: it is not an admin-assignable product, it is granted
 * to everyone unconditionally. Normalized form is lowercase (matches
 * `normalizeEntitlementKey`).
 */
export const BASE_ENTITLEMENT_KEY = 'base';

/**
 * A product's Stripe price ids, authored per-stage and captured BEFORE the
 * `isTestMode` resolution. The ternary resolves to ONE id at module load
 * (test-mode in CI), which would hide the inactive stage's id from the
 * registry test - so a one-sided fill-in (real test id, placeholder prod id)
 * would ship a broken checkout to production. Keeping both sides on the row
 * lets the test assert BOTH stages are real (see registry.test.ts).
 */
type StagedPriceId = { readonly test: string; readonly prod: string };
const resolveStagePriceId = (staged: StagedPriceId): string => (isTestMode ? staged.test : staged.prod);

/**
 * [DELETION-FOOTPRINT] LibreOncology Stripe price (test + live modes), $19/mo
 * recurring. Single source of truth - also consumed by the SUBSCRIPTION_PLANS row
 * in apps/client/lib/userSubscriptions/constants.ts (keep them in sync via this
 * export, not by re-typing the ids).
 *
 * Account-tied price ids are sourced per-stage from NEXT_PUBLIC_* env vars with no
 * brand fallback - empty when unconfigured == this product's checkout
 * is inactive. The env reads stay inline here to respect the module boundary (do
 * not import ids from a product namespace). If the amount ever changes, Stripe mints
 * a NEW price id - set the new id in the env and keep the old one mapped (below) so
 * existing subscribers retain access.
 */
const LIBREONCOLOGY_PRO_PRICE_IDS: StagedPriceId = {
  test: process.env.NEXT_PUBLIC_STRIPE_PRICE_LIBONC_TEST ?? '',
  prod: process.env.NEXT_PUBLIC_STRIPE_PRICE_LIBONC_PROD ?? '',
};

/** Resolved (stage-correct) LibreOncology Pro Stripe price id. */
export const LIBREONCOLOGY_PRO_PRICE_ID = resolveStagePriceId(LIBREONCOLOGY_PRO_PRICE_IDS);

/**
 * Stripe price -> entitlement key(s), authored per-stage. The runtime
 * `PRICE_ENTITLEMENT_ROWS` below resolves each to the deployed stage's id.
 */
const PRICE_STAGED_ROWS: ReadonlyArray<{ priceIds: StagedPriceId; entitlements: EntitlementKey[] }> = [
  // [DELETION-FOOTPRINT] LibreOncology Pro.
  { priceIds: LIBREONCOLOGY_PRO_PRICE_IDS, entitlements: ['libreoncology:pro'] },
];

const PRICE_ENTITLEMENT_ROWS: PriceEntitlementRow[] = PRICE_STAGED_ROWS.map(row => ({
  priceId: resolveStagePriceId(row.priceIds),
  entitlements: row.entitlements,
}));

/**
 * Comp-tag -> paid-key remap, applied ON TOP of the 1:1 tag->key passthrough.
 * Back-compat: an admin/comp-granted product tag confers the product's paid
 * entitlement without a subscription (ACCESS_MODEL §3.1 piece 4).
 */
const TAG_GRANT_ROWS: TagGrantRow[] = [
  // [DELETION-FOOTPRINT] LibreOncology comp grant - RETIRED (tag-retirement, Q3b follow-on).
  // The `libreoncology` access tag is no longer an entitlement input: comp/internal accounts
  // now hold `libreoncology:pro` via `source:'admin_grant'` subscriptions (the priceId path,
  // identical to a real subscriber), so the bare tag confers no access. The LibreOncology
  // PRICE_STAGED_ROWS entry below STAYS - subscriptions (admin_grant and Stripe) are how the
  // entitlement is granted now. Re-adding a row here would resurrect the retired tag key.
  // [DELETION-FOOTPRINT] OptiHashi comp grant: the existing `opti` access tag
  // bridges to `optihashi:pro`, so every Opti-tagged user keeps access through
  // the tag->entitlement cutover with no subscription (zero regression). The
  // matching PRICE_ENTITLEMENTS row is deferred to the subscriptions phase (no
  // OptiHashi Stripe price minted yet); the email-domain grant lives in
  // DOMAIN_GRANT_ROWS below.
  // The `opti` tag confers local OptiHashi access via `optihashi:pro` (solver
  // race, problem/run CRUD, UI/routing).
  { tag: 'opti', entitlements: ['optihashi:pro'] },
  // Remote compute is a SEPARATE, stricter tier from local OptiHashi: the
  // `opti-compute` tag bridges to `optihashi:compute`. Holding `optihashi:pro`
  // alone will NOT confer remote compute once the server gate checks
  // `optihashi:compute` (see M2) - until then this row is inert (no gate reads
  // the key yet). Granted-only for now (no Stripe price yet); deliberately absent
  // from DOMAIN_GRANT_ROWS / INTERNAL_STAFF_ENTITLEMENTS / SIGNUP_CREDIT_ROWS -
  // internal users reach it via admin/developer bypass, and no signup credits
  // attach to the compute tier.
  { tag: 'opti-compute', entitlements: ['optihashi:compute'] },
  // Real hardware compute is the STRICTEST tier: the `opti-hardware` tag bridges to
  // `optihashi:hardware`. Like `opti-compute` above, no gate in THIS repo reads the key yet -
  // the hardware submit gate lives in the premium overlay - so this row is inert host-side
  // until that overlay is composed in; it exists so the key is grantable/known here.
  // Deliberately its own tier, NOT implied by `optihashi:compute` (classical/simulator) or
  // `optihashi:pro` (local): a compute-tier user must not silently reach real external-provider
  // (real-money) spend. Granted-only (no Stripe price yet) and intentionally absent from
  // DOMAIN_GRANT_ROWS / INTERNAL_STAFF_ENTITLEMENTS / SIGNUP_CREDIT_ROWS - admins reach it via
  // bypass, and it is granted per-account rather than by domain/signup.
  { tag: 'opti-hardware', entitlements: ['optihashi:hardware'] },
  // [DELETION-FOOTPRINT] Overwatch comp grant: the `overwatch` tag bridges to
  // `overwatch:pro`. Admin-only gate was a stopgap before the entitlement model
  // existed (Open Core M0). No Stripe price yet; granted-only initially. Removed
  // when the Overwatch package is extracted to Bike4Mind/overwatch.
  { tag: 'overwatch', entitlements: ['overwatch:pro'] },
  // [DELETION-FOOTPRINT] Pi (Project Intelligence) comp grant: the `pi` tag
  // bridges to `pi:pro`. No gate existed previously (Open Core M0 adds it).
  // No Stripe price yet; granted-only initially. Removed when Pi is extracted.
  { tag: 'pi', entitlements: ['pi:pro'] },
  // [DELETION-FOOTPRINT] Tavern comp grant: the `tavern` tag bridges to
  // `tavern:pro`, preserving access for all existing tavern-tagged users through
  // the tag->entitlement cutover (M3.5 migration). Call sites still use the legacy
  // tag predicates until M3.5 migrates them to `requestHasTavernAccess`.
  { tag: 'tavern', entitlements: ['tavern:pro'] },
  // [DELETION-FOOTPRINT] Bob comp grant: the `bob` tag bridges to `bob:pro`, which
  // gates Bob's `/bob` route and its nav entry (the premium-bob overlay). No Stripe
  // price yet; granted-only initially. Removed when Bob is extracted.
  { tag: 'bob', entitlements: ['bob:pro'] },
];

/**
 * Verified-email-domain -> entitlement key(s). Anyone signing up with an
 * email in one of these domains auto-gets the keys FREE on signup, gated on a
 * VERIFIED email (`entitlementsForEmail`) - derive-on-read, no Stripe row and
 * no signup-time write, so existing users in the domain are covered and access
 * auto-revokes if the email changes.
 *
 * Domains are normalized lowercase (matched against the substring after the
 * last `@`). All grant rows are env-sourced (no customer/partner identity in
 * open-core code) - see the two env blocks below.
 */
/**
 * External customer domain-grant rows, sourced from env as JSON (open-core guard):
 * naming a real customer domain + the entitlements it confers is
 * customer-specific config, not shippable code - hardcoding it would leak the
 * customer and couple a fork to our deals. Empty/unset (a fork, or CI type-check)
 * -> no external grant, the correct default. Set the NEXT_PUBLIC_PREMIUM_DOMAIN_GRANTS
 * repo/org variable per stage - a JSON array of `{ domain, entitlements }` - to
 * activate; the value is injected at deploy time per infra/deploy-contract.json.
 *
 * Every domain granted here confers paid entitlements AND a one-time signup
 * credit allotment (see below) to any verified email on that domain. NEVER list a
 * public mail provider (gmail.com, etc.).
 */
const EXTERNAL_DOMAIN_GRANT_ROWS: DomainGrantRow[] = (() => {
  const raw = process.env.NEXT_PUBLIC_PREMIUM_DOMAIN_GRANTS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ domain?: unknown; entitlements?: unknown }>;
    return parsed
      .map(row => ({
        domain: normalizeTag(String(row.domain ?? '')),
        entitlements: (Array.isArray(row.entitlements) ? row.entitlements : []) as EntitlementKey[],
      }))
      .filter(row => row.domain && row.entitlements.length > 0);
  } catch {
    // Malformed value -> no external grant (fail closed); never throw at module load.
    return [];
  }
})();

/**
 * Internal staff domains (comma-separated) that get the same grant as external
 * customer staff - used to retest the customer onboarding flow (access + the
 * one-time signup credits below) on B4M infra without a real customer mailbox.
 *
 * Sourced from env with NO brand fallback (open-core guard): these
 * are B4M-account-tied domains, so hardcoding them in shippable code would
 * couple a fork to our infrastructure. Empty/unset (a fork, or CI type-check)
 * -> no internal-domain grant, which is the correct default. Set the
 * NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS repo/org variable (a comma-separated
 * domain list) per stage to activate; the value is injected at deploy time per infra/deploy-contract.json.
 *
 * Parsed via the shared helper so analytics resolves the same domains (#172).
 */
const INTERNAL_STAFF_DOMAINS: readonly string[] = parseInternalStaffDomains(
  process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS
);

/** Domains already covered by an external row (derived - no brand literals to keep in sync). */
const EXTERNAL_GRANT_DOMAINS = new Set(EXTERNAL_DOMAIN_GRANT_ROWS.map(row => row.domain));

/** Entitlements internal staff domains confer - mirrors the external customer grant set. */
const INTERNAL_STAFF_ENTITLEMENTS: EntitlementKey[] = ['optihashi:pro'];

const DOMAIN_GRANT_ROWS: DomainGrantRow[] = [
  ...EXTERNAL_DOMAIN_GRANT_ROWS,
  // Internal staff domains -> same grant as external customer staff, sourced from
  // env (above) so no B4M-account-tied literal ships in open-core code. De-duplicated
  // against the external rows (structurally, via EXTERNAL_GRANT_DOMAINS) so an env
  // value that overlaps one can't create a duplicate Map key - which would silently
  // last-win and trip the registry invariant test.
  ...INTERNAL_STAFF_DOMAINS.filter(domain => !EXTERNAL_GRANT_DOMAINS.has(domain)).map(domain => ({
    domain,
    entitlements: INTERNAL_STAFF_ENTITLEMENTS,
  })),
];

/**
 * Per-entitlement one-time signup credit grant. A domain-grant user (see
 * DOMAIN_GRANT_ROWS) receives the SUM of these amounts for every entitlement
 * key their verified email confers, granted ONCE at email verification
 * (apps/client/pages/api/email/verify.ts) - ADDITIVE on top of the flat
 * `defaultFreeCredits` open-registration grant, and with NO cap.
 *
 * Keyed on the entitlement, not the domain: any domain (external customer or
 * internal staff) that confers `optihashi:pro` grants the matching credits
 * (250,000, ~$250 at the ~$0.001/credit package rate). Future product rows
 * inherit this automatically by adding a key here.
 *
 * [DELETION-FOOTPRINT] The entry leaves with its product on extraction.
 */
const SIGNUP_CREDIT_ROWS: ReadonlyArray<{ key: EntitlementKey; credits: number }> = [
  { key: 'optihashi:pro', credits: 250_000 },
];

export const SIGNUP_CREDITS: ReadonlyMap<EntitlementKey, number> = new Map(
  SIGNUP_CREDIT_ROWS.map(row => [normalizeTag(row.key), row.credits])
);

export const PRICE_ENTITLEMENTS: ReadonlyMap<string, readonly EntitlementKey[]> = new Map(
  PRICE_ENTITLEMENT_ROWS.map(row => [row.priceId, row.entitlements])
);

export const TAG_GRANTS: ReadonlyMap<string, readonly EntitlementKey[]> = new Map(
  TAG_GRANT_ROWS.map(row => [normalizeTag(row.tag), row.entitlements])
);

export const DOMAIN_GRANTS: ReadonlyMap<string, readonly EntitlementKey[]> = new Map(
  DOMAIN_GRANT_ROWS.map(row => [normalizeTag(row.domain), row.entitlements])
);

/**
 * Every entitlement key the registry recognizes as a grantable product, sorted - the union of
 * every grant source (price, comp-tag, email-domain) via `allKnownEntitlementKeys`, so there is
 * one source of truth for "what products exist" (e.g. `optihashi:pro`, `libreoncology:pro`). New
 * products surface here automatically as their rows are added above. Admin surfaces that let an
 * operator pick an entitlement to grant (LLM model gating, partner signup rules) source their
 * options from this so a typo can't persist a dead grant.
 */
export const KNOWN_ENTITLEMENT_KEYS: readonly EntitlementKey[] = [...allKnownEntitlementKeys()].sort();

/**
 * The entitlement keys in `keys` the registry does NOT recognize (normalized, de-duplicated).
 * Empty means every key is a known grantable product. Used to reject typo'd keys at admin
 * write boundaries before they persist as a silent no-op grant.
 */
export function unknownEntitlementKeys(keys: Iterable<string>): string[] {
  const known = new Set(KNOWN_ENTITLEMENT_KEYS);
  const unknown = new Set<string>();
  for (const raw of keys) {
    const key = normalizeTag(raw);
    if (key && !known.has(key)) unknown.add(key);
  }
  return [...unknown];
}

/** Entitlement keys granted by the given Stripe priceIds. */
export function entitlementsForPriceIds(priceIds: readonly string[]): Set<EntitlementKey> {
  const keys = new Set<EntitlementKey>();
  for (const priceId of priceIds) {
    for (const key of PRICE_ENTITLEMENTS.get(priceId) ?? []) {
      keys.add(key);
    }
  }
  return keys;
}

/**
 * Entitlement keys granted by the given user tags: every tag passes through
 * as its own key (1:1, normalized - the briefcase `ICaller.entitlements`
 * precedent), plus any TAG_GRANTS remap rows.
 */
export function entitlementsForTags(tags: readonly string[]): Set<EntitlementKey> {
  const keys = new Set<EntitlementKey>();
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (!normalized) continue;
    keys.add(normalized);
    for (const key of TAG_GRANTS.get(normalized) ?? []) {
      keys.add(key);
    }
  }
  return keys;
}

/**
 * Entitlement keys granted by the user's email domain, gated on a VERIFIED
 * email. Returns the DOMAIN_GRANTS keys for the email's domain (the substring
 * after the last `@`, normalized lowercase) ONLY when `emailVerified === true`;
 * an empty set otherwise - unverified email, missing/empty email, an OAuth
 * private relay address with no matching domain, or a domain not in the map. No
 * grant is ever derived from an unverified address.
 */
export function entitlementsForEmail(
  email: string | null | undefined,
  emailVerified: boolean | null | undefined
): Set<EntitlementKey> {
  const keys = new Set<EntitlementKey>();
  if (emailVerified !== true || !email) return keys;
  const at = email.lastIndexOf('@');
  if (at < 0) return keys;
  const domain = normalizeTag(email.slice(at + 1));
  if (!domain) return keys;
  for (const key of DOMAIN_GRANTS.get(domain) ?? []) {
    keys.add(key);
  }
  return keys;
}

/**
 * One-time signup credit total for the given email, gated on a VERIFIED email.
 * Sums SIGNUP_CREDITS over the domain-grant entitlement keys the email confers
 * (reusing `entitlementsForEmail` as the resolver), so a two-product domain
 * user gets 500,000 and a single-product user gets 250,000. Returns 0 for an
 * unverified/missing email, a non-domain-grant email, or keys with no credit
 * amount configured. ADDITIVE and uncapped by design.
 */
export function signupCreditsForEmail(
  email: string | null | undefined,
  emailVerified: boolean | null | undefined
): number {
  return signupCreditsForKeys(entitlementsForEmail(email, emailVerified));
}

/**
 * Sum of the one-time signup credits for an already-resolved set of entitlement
 * keys (keys with no configured amount contribute 0). Lets a caller that already
 * holds the resolved keys (e.g. the email-verify handler, which also needs the
 * key set for cache invalidation) avoid re-resolving the email a second time.
 */
export function signupCreditsForKeys(keys: Iterable<EntitlementKey>): number {
  let total = 0;
  for (const key of keys) {
    total += SIGNUP_CREDITS.get(key) ?? 0;
  }
  return total;
}

/** Union of price-derived, tag-derived, and verified-email-domain entitlement keys. */
export function resolveEntitlements(input: {
  tags: readonly string[];
  activePriceIds: readonly string[];
  email?: string | null;
  emailVerified?: boolean | null;
}): EntitlementKey[] {
  const keys = entitlementsForPriceIds(input.activePriceIds);
  for (const key of entitlementsForTags(input.tags)) {
    keys.add(key);
  }
  for (const key of entitlementsForEmail(input.email, input.emailVerified)) {
    keys.add(key);
  }
  return [...keys];
}

/**
 * Every entitlement key any grant source can confer - derived from the row
 * VALUES (tag remaps, domain grants, price grants), not a separately
 * maintained list. Admin Product Access panel uses this to enumerate every
 * product it should show, so a new product row here is picked up
 * automatically with no second list to update.
 */
export function allKnownEntitlementKeys(): EntitlementKey[] {
  const keys = new Set<EntitlementKey>();
  for (const grantedKeys of TAG_GRANTS.values()) {
    for (const key of grantedKeys) keys.add(key);
  }
  for (const grantedKeys of DOMAIN_GRANTS.values()) {
    for (const key of grantedKeys) keys.add(key);
  }
  for (const grantedKeys of PRICE_ENTITLEMENTS.values()) {
    for (const key of grantedKeys) keys.add(key);
  }
  return [...keys];
}

/**
 * The single comp tag that grants `key` via TAG_GRANTS, or undefined if the
 * key has no tag-based grant path (e.g. `libreoncology:pro`, which is
 * subscription-only post-retirement - see the TAG_GRANT_ROWS comment above).
 * Assumes at most one granting tag per key (true of every row today); the
 * registry invariant tests would need extending if that ever changes.
 */
export function grantTagForEntitlement(key: EntitlementKey): string | undefined {
  const normalized = normalizeTag(key);
  for (const [tag, grantedKeys] of TAG_GRANTS) {
    if (grantedKeys.includes(normalized)) return tag;
  }
  return undefined;
}

/** Exposed for the registry invariant tests (not for feature code). */
export const __registryRows = {
  priceRows: PRICE_ENTITLEMENT_ROWS as readonly PriceEntitlementRow[],
  // Per-stage rows let the tripwire validate BOTH stages, not just the one the
  // isTestMode ternary resolves to at import time.
  stagedPriceRows: PRICE_STAGED_ROWS,
  tagGrantRows: TAG_GRANT_ROWS as readonly TagGrantRow[],
  domainGrantRows: DOMAIN_GRANT_ROWS as readonly DomainGrantRow[],
  signupCreditRows: SIGNUP_CREDIT_ROWS,
};
