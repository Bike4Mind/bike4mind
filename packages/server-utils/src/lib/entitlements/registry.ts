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
 *
 * Overlays add rows without editing this file: `b4mContributions.entitlementGrants` is validated
 * at codegen and added to the built-in rows by `mergeContributedRows` (new territory only), so the
 * tag, implied, signup-credit and staff-domain maps below see both.
 */
import type { DomainGrantRow, EntitlementKey, ImpliedEntitlementRow, PriceEntitlementRow, TagGrantRow } from './types';
import { isTestMode } from '../subscriptions/constants';
import {
  parseInternalStaffDomains,
  DATA_LAKE_SLUG_REGEX,
  MAX_DATA_LAKE_SLUG_LENGTH,
  isOAuthSourceTag,
  PENDING_FREE_CREDITS_TAG,
  PAID_PLAN_ENTITLEMENT_KEY,
} from '@bike4mind/common';
import type { PremiumEntitlementGrants } from '@bike4mind/common';
import { premiumEntitlementGrants } from '../../premium-generated/premiumEntitlementGrants.generated';

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
 * Entitlement gating white-label branding (`hideBranding`) on an embed key
 * (epic #41 Phase D). Shared by the widget serve route (owner-scoped, the
 * authoritative check) and the key write routes (caller-scoped defense in depth).
 */
export const EMBED_WHITELABEL_ENTITLEMENT_KEY: EntitlementKey = 'embed:whitelabel';

/**
 * Entitlements whose real enforcement is OWNER-scoped through the raw
 * `getUserEntitlements` resolver and so honors NEITHER the admin nor the
 * developer gate bypass - a literal grant (tag / subscription / domain) is
 * required. The admin Product Access resolver must therefore NOT attribute
 * these to `admin-bypass` / `developer-bypass`, or it reports access the gate
 * won't actually confer. Must stay in sync with the enforcement side
 * (`server/entitlements/embedKeyEntitlement.ts` -> `embedKeyOwnerHasEntitlement`).
 * `embed:whitelabel` is the only such key today; the OptiHashi/Overwatch/Bob/Pi
 * entitlements are gated caller-scoped (via `requestHasEntitlement` / the client
 * gate, which DO bypass for admin/developer), so reporting the bypass for them is
 * correct and they are not members.
 */
export const BYPASS_EXEMPT_ENTITLEMENTS: ReadonlySet<EntitlementKey> = new Set([EMBED_WHITELABEL_ENTITLEMENT_KEY]);

/** Whether `key` is bypass-exempt (see `BYPASS_EXEMPT_ENTITLEMENTS`). Normalizes first. */
export function isBypassExemptEntitlement(key: EntitlementKey): boolean {
  return BYPASS_EXEMPT_ENTITLEMENTS.has(normalizeTag(key));
}

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
  // The `optihashi:compute` / `optihashi:hardware` execution tiers used to be
  // granted here via the `opti-compute` / `opti-hardware` tags. Retired (#1237):
  // those tiers now resolve from org group membership (the overlay's group->
  // capability map, #1178), so `optihashi:pro` is the single product-level grant
  // and group membership decides what you reach within it. The tag rows were
  // already inert in open core (no gate here ever read the keys).
  // INTENDED CONSEQUENCE (deliberate, not a regression): removing the rows also
  // drops `opti-compute` / `opti-hardware` from `allKnownEntitlementKeys()`, so
  // the admin Users profile no longer classifies them as managed - a leftover
  // `opti-compute` tag now renders as a removable custom-tag chip in the admin
  // Users panel (with no Product Access control, because the tier is retired).
  // That is how an operator strips the inert leftover.
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
  // [DELETION-FOOTPRINT] Bob comp grant: the `bob` tag bridges to `bob:pro`. Bob is now
  // open to every signed-in account, so nothing checks `bob:pro` (not the `/bob` route,
  // its nav entry, or the `bob:read`/`bob:run` API-key scopes, which are deliberately
  // ungated in GATED_API_KEY_SCOPES). The row is kept so the key stays known to existing
  // grants and the admin Product Access panel. No Stripe price. Removed when Bob is extracted.
  { tag: 'bob', entitlements: ['bob:pro'] },
  // [DELETION-FOOTPRINT] Interactive Meetings comp grant: the `meetings` tag bridges to
  // `meetings:pro`, which gates the `/meetings` route and its rail entry (the
  // interactive-meetings overlay). No Stripe price; granted-only, and deliberately so - the
  // product is not ready to be self-serve. Listing it here is what puts the key in
  // KNOWN_ENTITLEMENT_KEYS, so it can be granted from the admin Product Access panel instead
  // of by writing a tag straight into the user document, and so the partner-rules write
  // boundary stops rejecting it as unknown. Removed when the overlay is extracted.
  { tag: 'meetings', entitlements: ['meetings:pro'] },
  // [DELETION-FOOTPRINT] Questmaster comp grant: the `questmaster-pro` tag bridges to
  // `questmaster:pro`. No Stripe price; granted-only. Listing it here puts the key in
  // KNOWN_ENTITLEMENT_KEYS (admin Product Access + the partner-rules write boundary).
  // Holders of `optihashi:pro` also get it via IMPLIED_ENTITLEMENT_ROWS below.
  // NOT the bare `questmaster` tag: that is an existing cohort tag (Invite Center colors
  // `QuestMaster`, see InviteCenter/shared/tagColors.ts), and tags match case-insensitively,
  // so mapping it would silently grant the product to every cohort member.
  { tag: 'questmaster-pro', entitlements: ['questmaster:pro'] },
  // Embed white-label: the `embed-whitelabel` tag bridges to `embed:whitelabel`,
  // which gates hiding the "Powered by" branding on the public embed widget
  // (epic #41 Phase D). Checked against the KEY OWNER (org billing owner), not
  // the viewer - see server/entitlements/embedKeyEntitlement.ts. Granted-only
  // for now (no Stripe price yet).
  { tag: 'embed-whitelabel', entitlements: ['embed:whitelabel'] },
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
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[])
      .filter((row): row is { domain?: unknown; entitlements?: unknown } => typeof row === 'object' && row !== null)
      .map(row => ({
        domain: normalizeTag(String(row.domain ?? '')),
        // Non-string entries are dropped (they would throw in normalizeTag on the hot path)
        // and each key is normalized, so a mixed-case env key matches like every other source.
        entitlements: (Array.isArray(row.entitlements) ? row.entitlements : [])
          .filter((key): key is string => typeof key === 'string')
          .map(normalizeTag)
          .filter(Boolean),
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

/**
 * Per-entitlement one-time signup credit grant. A domain-grant user (see
 * DOMAIN_GRANT_ROWS) receives the SUM of these amounts for every entitlement
 * key their verified email confers (an implied key never paying twice - see
 * `signupCreditsForKeys`), granted ONCE at email verification
 * (apps/client/pages/api/email/verify.ts) - ADDITIVE on top of the flat
 * `defaultFreeCredits` open-registration grant, and with NO cap.
 *
 * Keyed on the entitlement, not the domain: any domain (external customer or
 * internal staff) that confers `optihashi:pro` grants the matching credits
 * (250,000, ~$250 at the ~$0.001/credit package rate). Future product rows
 * inherit this automatically by adding a key here.
 *
 * Summed over the keys the domain confers DIRECTLY - implied entitlements
 * (IMPLIED_ENTITLEMENT_ROWS) are not expanded here, so an implication never
 * adds signup credits on its own; and a directly conferred key that another
 * held key implies counts zero, so {optihashi:pro, questmaster:pro} pays once.
 *
 * [DELETION-FOOTPRINT] Each entry leaves with its product on extraction.
 */
const SIGNUP_CREDIT_ROWS: ReadonlyArray<{ key: EntitlementKey; credits: number }> = [
  { key: 'optihashi:pro', credits: 250_000 },
  { key: 'questmaster:pro', credits: 250_000 },
];

/**
 * Implied entitlements: holding `ifHeld` also grants `alsoGrant`, whatever source
 * granted `ifHeld` (subscription, tag, env domain, DB partner rule). Applied once in
 * `getUserEntitlements` after every source has resolved, so `/api/entitlements`, the
 * SPA gate and the server gates all agree; the admin Product Access resolver reports
 * the result as an `implied` source.
 *
 * [DELETION-FOOTPRINT] Each row leaves with its product on extraction.
 */
const IMPLIED_ENTITLEMENT_ROWS: ImpliedEntitlementRow[] = [{ ifHeld: 'optihashi:pro', alsoGrant: ['questmaster:pro'] }];

/** The registry rows an overlay can extend; price and domain rows stay env-sourced. */
export interface ExtensibleRegistryRows {
  tagGrantRows: readonly TagGrantRow[];
  impliedRows: readonly ImpliedEntitlementRow[];
  signupCreditRows: readonly { key: EntitlementKey; credits: number }[];
  internalStaffEntitlements: readonly EntitlementKey[];
}

const keyList = (value: unknown): EntitlementKey[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((key): key is string => typeof key === 'string')
            .map(normalizeTag)
            .filter(Boolean)
        ),
      ]
    : [];

const rowList = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    : [];

/**
 * Contributed signup credits per key may not exceed this. A literal rather than the largest built-in
 * amount, so it survives those rows leaving; registry.test.ts holds the built-in amounts under it and
 * premiumEntitlementGrants.test.ts holds the codegen copy in apps/client/scripts/generate-premium-glue.mjs equal.
 */
export const MAX_CONTRIBUTED_SIGNUP_CREDITS = 250_000;

/**
 * Keys and ids a contribution may never name: `base` is held by every user, `datalake:` and
 * `embed:` keys need a literal owner grant, and `source:` tags are self-assertable OAuth
 * attribution. `customer` and `pending-free-credits` are stamped on accounts by core, and `plan:paid` is
 * derived from the subscription ladder or a credit purchase only. Must stay in sync with the codegen
 * check.
 */
export function isReservedContributionKey(key: string): boolean {
  return (
    key === BASE_ENTITLEMENT_KEY ||
    key.startsWith('datalake:') ||
    key.startsWith('embed:') ||
    isOAuthSourceTag(key) ||
    key === 'customer' ||
    key === PENDING_FREE_CREDITS_TAG ||
    key === PAID_PLAN_ENTITLEMENT_KEY
  );
}

export interface MergeContributedRowsOptions {
  /** Keys core grants outside `builtIn` (price and env domain rows); a contribution may not grant them. */
  otherCoreKeys?: Iterable<string>;
  /** Called once per contributed row or key that was dropped, with the reason. */
  onReject?: (reason: string) => void;
}

/**
 * `builtIn` with `contributed` added, strictly in new territory: a contributed row that names a
 * built-in tag, implying key or priced key must repeat the built-in value (a no-op), and a
 * contributed tag, implication, credit or staff key may not grant a key core already grants (built-in
 * tag names count, since user tags pass through as keys). A key core only pays signup credits on is
 * not one it grants, so a contribution may grant it; the credit is still paid once. An implication
 * must start from a key a contributed row grants, and a credit row must sit on a contributed staff
 * key. Every other conflict, reserved key and out-of-range amount is dropped and reported through
 * `onReject`; malformed shapes (non-strings, empty lists) are dropped silently, as codegen already
 * rejects them.
 * This runs at module load, so it never throws.
 */
export function mergeContributedRows(
  builtIn: ExtensibleRegistryRows,
  contributed: PremiumEntitlementGrants | undefined,
  options: MergeContributedRowsOptions = {}
): ExtensibleRegistryRows {
  const reject = (reason: string) => options.onReject?.(reason);
  const source: Record<string, unknown> =
    typeof contributed === 'object' && contributed !== null ? (contributed as Record<string, unknown>) : {};

  const coreTags = new Map(
    builtIn.tagGrantRows.map(row => [normalizeTag(row.tag), new Set(row.entitlements.map(normalizeTag))])
  );
  const coreImplied = new Map(
    builtIn.impliedRows.map(row => [normalizeTag(row.ifHeld), new Set(row.alsoGrant.map(normalizeTag))])
  );
  const coreCredits = new Map(builtIn.signupCreditRows.map(row => [normalizeTag(row.key), row.credits]));
  const coreStaff = new Set(builtIn.internalStaffEntitlements.map(normalizeTag));
  const coreKeys = new Set<string>([
    ...[...coreTags.values()].flatMap(keys => [...keys]),
    ...coreImplied.keys(),
    ...[...coreImplied.values()].flatMap(keys => [...keys]),
    ...coreStaff,
    ...coreTags.keys(),
    ...[...(options.otherCoreKeys ?? [])].map(normalizeTag),
  ]);
  const isSubset = (keys: readonly string[], of: ReadonlySet<string>) => keys.every(key => of.has(key));
  const rejectsKeys = (where: string, keys: readonly string[]): boolean => {
    const reserved = keys.filter(isReservedContributionKey);
    const owned = keys.filter(key => coreKeys.has(key));
    if (reserved.length > 0) reject(`${where} names reserved key(s) ${reserved.join(', ')}`);
    else if (owned.length > 0) reject(`${where} names key(s) core already grants: ${owned.join(', ')}`);
    return reserved.length > 0 || owned.length > 0;
  };

  const tagGrantRows: TagGrantRow[] = builtIn.tagGrantRows.map(row => ({
    tag: normalizeTag(row.tag),
    entitlements: row.entitlements.map(normalizeTag),
  }));
  const contributedTagOf = new Map<string, string>();
  const contributedTags = new Map<string, EntitlementKey[]>();
  for (const row of rowList(source.tagGrants)) {
    const tag = typeof row.tag === 'string' ? normalizeTag(row.tag) : '';
    const keys = keyList(row.entitlements);
    if (!tag || keys.length === 0) continue;
    const coreRow = coreTags.get(tag);
    if (coreRow) {
      if (!isSubset(keys, coreRow)) reject(`tag "${tag}" is a built-in tag; a contribution may not change it`);
      continue;
    }
    if (isReservedContributionKey(tag) || coreKeys.has(tag)) {
      reject(`tag "${tag}" is reserved or names a core key`);
      continue;
    }
    if (rejectsKeys(`tag "${tag}"`, keys)) continue;
    const taken = keys.filter(key => (contributedTagOf.get(key) ?? tag) !== tag);
    if (taken.length > 0) {
      reject(`tag "${tag}" grants key(s) another tag already grants: ${taken.join(', ')}`);
      continue;
    }
    for (const key of keys) contributedTagOf.set(key, tag);
    contributedTags.set(tag, [...new Set([...(contributedTags.get(tag) ?? []), ...keys])]);
  }
  for (const [tag, entitlements] of contributedTags) tagGrantRows.push({ tag, entitlements });

  const internalStaffEntitlements = [...coreStaff];
  const contributedStaff = new Set<string>();
  for (const key of keyList(source.internalStaffEntitlements)) {
    if (coreStaff.has(key) || rejectsKeys(`internal staff key "${key}"`, [key])) continue;
    internalStaffEntitlements.push(key);
    contributedStaff.add(key);
  }

  const impliedRows: ImpliedEntitlementRow[] = builtIn.impliedRows.map(row => ({
    ifHeld: normalizeTag(row.ifHeld),
    alsoGrant: row.alsoGrant.map(normalizeTag),
  }));
  const contributedImplied = new Map<string, EntitlementKey[]>();
  const keptImplied = new Set<string>();
  for (const row of rowList(source.impliedEntitlements)) {
    const ifHeld = typeof row.ifHeld === 'string' ? normalizeTag(row.ifHeld) : '';
    const keys = keyList(row.alsoGrant);
    if (!ifHeld || keys.length === 0) continue;
    const coreRow = coreImplied.get(ifHeld);
    if (coreRow) {
      if (!isSubset(keys, coreRow))
        reject(`ifHeld "${ifHeld}" is a built-in implication; a contribution may not change it`);
      continue;
    }
    if (rejectsKeys(`ifHeld "${ifHeld}"`, [ifHeld]) || rejectsKeys(`implication from "${ifHeld}"`, keys)) continue;
    contributedImplied.set(ifHeld, [...new Set([...(contributedImplied.get(ifHeld) ?? []), ...keys])]);
  }
  const granted = new Set<string>([...contributedTagOf.keys(), ...contributedStaff]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [ifHeld, alsoGrant] of contributedImplied) {
      if (!granted.has(ifHeld) || keptImplied.has(ifHeld)) continue;
      keptImplied.add(ifHeld);
      impliedRows.push({ ifHeld, alsoGrant });
      for (const key of alsoGrant) granted.add(key);
      grew = true;
    }
  }
  for (const ifHeld of contributedImplied.keys()) {
    if (!keptImplied.has(ifHeld)) reject(`ifHeld "${ifHeld}" is not granted by any contributed row`);
  }

  const credits = new Map<EntitlementKey, number>(coreCredits);
  for (const row of rowList(source.signupCredits)) {
    if (typeof row.key !== 'string' || typeof row.credits !== 'number') continue;
    const key = normalizeTag(row.key);
    if (!key) continue;
    if (coreCredits.has(key)) {
      if (coreCredits.get(key) !== row.credits)
        reject(`signup credits for "${key}" are built-in; a contribution may not change them`);
      continue;
    }
    if (!Number.isInteger(row.credits) || row.credits <= 0 || row.credits > MAX_CONTRIBUTED_SIGNUP_CREDITS) {
      reject(`signup credits for "${key}" must be an integer from 1 to ${MAX_CONTRIBUTED_SIGNUP_CREDITS}`);
      continue;
    }
    if (rejectsKeys(`signup credits for "${key}"`, [key])) continue;
    if (credits.has(key)) {
      if (credits.get(key) !== row.credits)
        reject(`signup credits for "${key}" are contributed twice with different amounts`);
      continue;
    }
    if (!contributedStaff.has(key)) {
      reject(`signup credits for "${key}" must sit on a contributed internal staff key`);
      continue;
    }
    credits.set(key, row.credits);
  }
  const signupCreditRows = [...credits].map(([key, amount]) => ({ key, credits: amount }));

  return { tagGrantRows, impliedRows, signupCreditRows, internalStaffEntitlements };
}

const BUILT_IN_ROWS: ExtensibleRegistryRows = {
  tagGrantRows: TAG_GRANT_ROWS,
  impliedRows: IMPLIED_ENTITLEMENT_ROWS,
  signupCreditRows: SIGNUP_CREDIT_ROWS,
  internalStaffEntitlements: INTERNAL_STAFF_ENTITLEMENTS,
};

/** Keys core grants through price and env domain rows, outside the rows an overlay can extend. */
const CORE_OTHER_KEYS: readonly EntitlementKey[] = [
  ...PRICE_ENTITLEMENT_ROWS.flatMap(row => row.entitlements),
  ...EXTERNAL_DOMAIN_GRANT_ROWS.flatMap(row => row.entitlements),
];

const REJECTED_CONTRIBUTIONS: string[] = [];

const REGISTRY_ROWS: ExtensibleRegistryRows = mergeContributedRows(BUILT_IN_ROWS, premiumEntitlementGrants, {
  otherCoreKeys: CORE_OTHER_KEYS,
  onReject: reason => REJECTED_CONTRIBUTIONS.push(reason),
});
if (REJECTED_CONTRIBUTIONS.length > 0) {
  console.warn(`[entitlements] dropped contributed registry rows: ${REJECTED_CONTRIBUTIONS.join('; ')}`);
}

const CONTRIBUTED_STAFF_KEYS = REGISTRY_ROWS.internalStaffEntitlements.filter(
  key => !BUILT_IN_ROWS.internalStaffEntitlements.includes(key)
);
const INTERNAL_STAFF_DOMAIN_SET = new Set(INTERNAL_STAFF_DOMAINS);

const DOMAIN_GRANT_ROWS: DomainGrantRow[] = [
  // Preserve external-row precedence for built-in keys, while still applying staff contributions
  // when a domain is configured in both lists.
  ...EXTERNAL_DOMAIN_GRANT_ROWS.map(row => ({
    ...row,
    entitlements: INTERNAL_STAFF_DOMAIN_SET.has(row.domain)
      ? [...new Set([...row.entitlements, ...CONTRIBUTED_STAFF_KEYS])]
      : row.entitlements,
  })),
  // Internal staff domains -> same grant as external customer staff, sourced from
  // env (above) so no B4M-account-tied literal ships in open-core code. De-duplicated
  // against the external rows (structurally, via EXTERNAL_GRANT_DOMAINS) so an env
  // value that overlaps one can't create a duplicate Map key - which would silently
  // last-win and trip the registry invariant test.
  ...INTERNAL_STAFF_DOMAINS.filter(domain => !EXTERNAL_GRANT_DOMAINS.has(domain)).map(domain => ({
    domain,
    entitlements: [...REGISTRY_ROWS.internalStaffEntitlements],
  })),
];

export const IMPLIED_ENTITLEMENTS: ReadonlyMap<EntitlementKey, readonly EntitlementKey[]> = new Map(
  REGISTRY_ROWS.impliedRows.map(row => [normalizeTag(row.ifHeld), row.alsoGrant.map(normalizeTag)])
);

/**
 * `keys` (normalized, de-duplicated, input order kept) followed by every key they
 * imply via IMPLIED_ENTITLEMENTS, appended in first-discovered order. One linear walk
 * over a growing list: an implied key is itself checked for implications, so a chain
 * added later resolves fully, and a cycle terminates because each key is visited once.
 * Deterministic for a given input order.
 */
export function applyImpliedEntitlements(
  keys: Iterable<EntitlementKey>,
  implications: ReadonlyMap<EntitlementKey, readonly EntitlementKey[]> = IMPLIED_ENTITLEMENTS
): EntitlementKey[] {
  const seen = new Set<EntitlementKey>();
  const ordered: EntitlementKey[] = [];
  const add = (key: unknown) => {
    // Defensive: a malformed source (env JSON, a DB row) must not throw on this hot path.
    if (typeof key !== 'string') return;
    const normalized = normalizeTag(key);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    ordered.push(normalized);
  };
  for (const key of keys) add(key);
  for (let i = 0; i < ordered.length; i++) {
    for (const implied of implications.get(ordered[i]) ?? []) add(implied);
  }
  return ordered;
}

export const SIGNUP_CREDITS: ReadonlyMap<EntitlementKey, number> = new Map(
  REGISTRY_ROWS.signupCreditRows.map(row => [normalizeTag(row.key), row.credits])
);

export const PRICE_ENTITLEMENTS: ReadonlyMap<string, readonly EntitlementKey[]> = new Map(
  PRICE_ENTITLEMENT_ROWS.map(row => [row.priceId, row.entitlements])
);

export const TAG_GRANTS: ReadonlyMap<string, readonly EntitlementKey[]> = new Map(
  REGISTRY_ROWS.tagGrantRows.map(row => [normalizeTag(row.tag), row.entitlements])
);

export const DOMAIN_GRANTS: ReadonlyMap<string, readonly EntitlementKey[]> = new Map(
  DOMAIN_GRANT_ROWS.map(row => [normalizeTag(row.domain), row.entitlements])
);

/**
 * Every entitlement key the registry recognizes as a grantable product, sorted - the union of
 * every grant source (price, comp-tag, email-domain, implied) via `allKnownEntitlementKeys`, so
 * there is one source of truth for "what products exist" (e.g. `optihashi:pro`,
 * `libreoncology:pro`). New products surface here automatically as their rows are added above.
 * Admin surfaces that let an operator pick an entitlement to grant (LLM model gating, partner
 * signup rules) source their options from this so a typo can't persist a dead grant.
 */
export const KNOWN_ENTITLEMENT_KEYS: readonly EntitlementKey[] = [...allKnownEntitlementKeys()].sort();

/**
 * Entitlement key family for lake-scoped grants (`IDataLake.requiredEntitlement`,
 * dataLakes epic #1658 lane D). A datalake entitlement is admin-authored per lake
 * with an arbitrary slug - there is no fixed catalog of lakes to enumerate as a grant
 * row here (and an open-core file must never name a customer's lake), so unlike every
 * other key in this registry it can't be listed. Recognized as KNOWN by pattern
 * instead: `datalake:<slug>`, slug matching the same rule as a lake slug
 * (`CreateDataLakeRequestInput` in b4m-core/common/src/schemas/dataLake.ts). Deliberately
 * NOT added to `KNOWN_ENTITLEMENT_KEYS` (that list is "products with a fixed identity";
 * a lake slug is per-tenant data) - checked separately in `unknownEntitlementKeys`.
 *
 * Known gap: this only validates SHAPE, not that a lake with that slug exists - a
 * well-formed but nonexistent/mistyped slug is accepted as "known" and would persist as a
 * silent no-op grant (the same class of bug #324 fixed for the fixed catalog). Closing that
 * needs a DB read against `DataLakeModel`, which belongs with the read-time grant resolution
 * work (dataLakes epic #1658 lane C, #1673), not this pattern-registration step.
 */
const DATALAKE_ENTITLEMENT_PREFIX = 'datalake:';
// The shape and max come from the same constants CreateDataLakeRequestInput validates against,
// so this gate cannot drift from what a lake slug is allowed to be. A longer slug can't belong
// to a real lake, so accepting it here would reopen the exact silent-no-op-grant risk
// `unknownEntitlementKeys` exists to close. (The 2-char minimum is already implied by the regex
// shape: first char + last char, with the middle `*` allowed to match zero characters.)

/**
 * Whether `key` is a `datalake:<slug>` entitlement. Normalizes internally (matches
 * `isBypassExemptEntitlement` above) so a caller can't get a wrong answer by forgetting to
 * normalize first.
 */
export function isDatalakeEntitlementKey(key: string): boolean {
  const normalized = normalizeTag(key);
  if (!normalized.startsWith(DATALAKE_ENTITLEMENT_PREFIX)) return false;
  const slug = normalized.slice(DATALAKE_ENTITLEMENT_PREFIX.length);
  return slug.length <= MAX_DATA_LAKE_SLUG_LENGTH && DATA_LAKE_SLUG_REGEX.test(slug);
}

/**
 * The entitlement keys in `keys` the registry does NOT recognize (normalized, de-duplicated).
 * Empty means every key is a known grantable product, or a `datalake:<slug>` grant (see
 * `isDatalakeEntitlementKey`). Used to reject typo'd keys at admin write boundaries before
 * they persist as a silent no-op grant.
 *
 * `known` defaults to the real catalog; it is injectable so the catalog test can prove an
 * implied-only key counts as known without adding a fake product to the shipped registry.
 */
export function unknownEntitlementKeys(
  keys: Iterable<string>,
  known: ReadonlySet<string> = new Set(KNOWN_ENTITLEMENT_KEYS)
): string[] {
  const unknown = new Set<string>();
  for (const raw of keys) {
    const key = normalizeTag(raw);
    if (key && !known.has(key) && !isDatalakeEntitlementKey(key)) unknown.add(key);
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
    if (!normalized || isOAuthSourceTag(normalized)) continue;
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
 * keys (normalized and de-duplicated; keys with no configured amount contribute 0).
 * A key that ANOTHER key in the same set implies (IMPLIED_ENTITLEMENTS, through
 * chains) counts zero, so a bundle never pays twice: {optihashi:pro,
 * questmaster:pro} pays 250,000, the same as either alone. Unrelated products
 * still sum. Lets a caller that already holds the resolved keys (e.g. the
 * email-verify handler, which also needs the key set for cache invalidation)
 * avoid re-resolving the email a second time.
 */
export function signupCreditsForKeys(
  keys: Iterable<EntitlementKey>,
  credits: ReadonlyMap<EntitlementKey, number> = SIGNUP_CREDITS,
  implications: ReadonlyMap<EntitlementKey, readonly EntitlementKey[]> = IMPLIED_ENTITLEMENTS
): number {
  // An empty implication map makes this a pure normalize + de-duplicate.
  const held = applyImpliedEntitlements(keys, new Map());
  const impliedByAnother = new Set<EntitlementKey>();
  for (const key of held) {
    // slice(1) drops `key` itself; the rest is everything it implies through chains.
    for (const implied of applyImpliedEntitlements([key], implications).slice(1)) impliedByAnother.add(implied);
  }
  let total = 0;
  for (const key of held) {
    if (!impliedByAnother.has(key)) total += credits.get(key) ?? 0;
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
 * VALUES (tag remaps, domain grants, price grants, implied `alsoGrant` keys),
 * not a separately maintained list. Admin Product Access panel uses this to
 * enumerate every product it should show, so a new product row here is picked up
 * automatically with no second list to update. The implied keys are included so
 * a key that is only ever implied (no tag/price/domain row of its own) is still
 * shown in Product Access and accepted at the partner-rule write boundary.
 *
 * `implications` defaults to the real graph; it is injectable so the catalog
 * test can prove the implied branch is load-bearing (today's only implied key
 * also has a grant row, so a dropped implied loop would otherwise go unnoticed).
 */
export function allKnownEntitlementKeys(
  implications: ReadonlyMap<EntitlementKey, readonly EntitlementKey[]> = IMPLIED_ENTITLEMENTS
): EntitlementKey[] {
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
  for (const grantedKeys of implications.values()) {
    for (const key of grantedKeys) keys.add(key);
  }
  // Listed even when no staff domain is configured, so partner rules accept them.
  for (const key of REGISTRY_ROWS.internalStaffEntitlements) keys.add(key);
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
  tagGrantRows: REGISTRY_ROWS.tagGrantRows,
  domainGrantRows: DOMAIN_GRANT_ROWS as readonly DomainGrantRow[],
  signupCreditRows: REGISTRY_ROWS.signupCreditRows,
  impliedRows: REGISTRY_ROWS.impliedRows,
  builtInRows: BUILT_IN_ROWS,
  contributedRows: premiumEntitlementGrants,
  rejectedContributions: REJECTED_CONTRIBUTIONS as readonly string[],
  otherCoreKeys: CORE_OTHER_KEYS,
};
