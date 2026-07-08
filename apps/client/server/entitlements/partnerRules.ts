/**
 * DB-backed partner signup rules (issue #293) - the runtime, admin-managed
 * source of domain-grant entitlements + one-time signup credits, replacing the
 * env-only `NEXT_PUBLIC_PREMIUM_DOMAIN_GRANTS` registry rows.
 *
 * This module is SERVER-ONLY: it reads `@bike4mind/database`, so it must never
 * be imported from `apps/client/app/**` (the browser bundle) - the pure
 * registry (`@client/lib/entitlements/registry`) stays the isomorphic layer.
 * The env registry rows remain a fallback (see the resolver callers) so nothing
 * regresses before the collection is seeded.
 *
 * Derive-on-read runs on hot paths (`getUserEntitlements`), so rules are cached
 * in-process behind a short TTL rather than queried per call. Admin writes call
 * `invalidatePartnerRuleCache()` to drop the cache immediately; across warm
 * Lambda instances the TTL bounds staleness. `normalizeTag` is the ONE
 * comparison rule shared with the registry so domain/key matching is identical.
 */
import { partnerSignupRuleRepository } from '@bike4mind/database';
import { normalizeTag } from '@client/lib/entitlements/registry';
import type { EntitlementKey } from '@client/lib/entitlements/types';

/** Resolved rule shape held in the cache (domain is the Map key). */
type ResolvedRule = {
  entitlements: EntitlementKey[];
  signupCredits: number;
};

/** How long a loaded rule set is trusted before a refresh (ms). */
const CACHE_TTL_MS = 60_000;

type RuleCache = {
  rules: Map<string, ResolvedRule>;
  loadedAt: number;
};

let cache: RuleCache | null = null;
// Coalesce concurrent refreshes so a burst of requests triggers ONE DB read.
let inflight: Promise<Map<string, ResolvedRule>> | null = null;

async function loadRules(): Promise<Map<string, ResolvedRule>> {
  const active = await partnerSignupRuleRepository.findActiveRules();
  const map = new Map<string, ResolvedRule>();
  for (const rule of active) {
    const domain = normalizeTag(rule.domain);
    if (!domain) continue;
    map.set(domain, {
      entitlements: rule.entitlements.map(normalizeTag).filter(Boolean),
      signupCredits: rule.signupCredits ?? 0,
    });
  }
  cache = { rules: map, loadedAt: Date.now() };
  return map;
}

async function getRulesMap(): Promise<Map<string, ResolvedRule>> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.rules;
  }
  // A refresh is already running - await it instead of firing a second query.
  //
  // Fail CLOSED on a DB error: return an empty map (no partner grants) rather than
  // rejecting. Entitlement resolution and the email-verify handler both call through
  // here on paths that must not throw - a rejection would break entitlement gating and
  // (verify runs this AFTER the email is already verified) surface a false
  // "Verification Failed". The failure is not cached, so the next call retries and
  // recovers. loadRules only assigns `cache` on success, so a transient error can't
  // pin a stale/empty map.
  inflight ??= loadRules()
    .catch(error => {
      // Fail closed, but never silently: a DB outage degrades every partner to zero grants,
      // so surface it for alerting. No req-scoped logger here (module-level cache) - console
      // is picked up by the Lambda log pipeline.
      console.error('[partnerRules] failed to load signup rules; failing closed to no grants', error);
      return new Map<string, ResolvedRule>();
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Drop the cache so the next resolution reloads from the DB. Call after any admin write. */
export function invalidatePartnerRuleCache(): void {
  cache = null;
}

/** The rule matching an email's verified domain, or null. Extracted like the registry (after last `@`). */
async function ruleForEmail(
  email: string | null | undefined,
  emailVerified: boolean | null | undefined
): Promise<ResolvedRule | null> {
  if (emailVerified !== true || !email) return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = normalizeTag(email.slice(at + 1));
  if (!domain) return null;
  const rules = await getRulesMap();
  return rules.get(domain) ?? null;
}

/**
 * DB-derived entitlement keys for a verified email's domain (empty set if no
 * rule matches / email unverified). Unioned on top of the env registry grants
 * by `getUserEntitlements` - additive, so an env-configured domain still works
 * until it is migrated into the collection.
 */
export async function partnerEntitlementsForEmail(
  email: string | null | undefined,
  emailVerified: boolean | null | undefined
): Promise<Set<EntitlementKey>> {
  const rule = await ruleForEmail(email, emailVerified);
  return new Set(rule?.entitlements ?? []);
}

/**
 * The one-time signup grant for a verified email, resolved from the DB rule.
 * `matched` distinguishes "a rule set credits to 0" (a valid config - grant
 * access, no bonus) from "no rule" (caller falls back to the env
 * `signupCreditsForEmail`). Returns the rule's entitlement keys too so the
 * email-verify handler can gate its cache-invalidation on the same result.
 */
export async function partnerSignupGrantForEmail(
  email: string | null | undefined,
  emailVerified: boolean | null | undefined
): Promise<{ matched: boolean; entitlements: Set<EntitlementKey>; signupCredits: number }> {
  const rule = await ruleForEmail(email, emailVerified);
  if (!rule) return { matched: false, entitlements: new Set(), signupCredits: 0 };
  return {
    matched: true,
    entitlements: new Set(rule.entitlements),
    signupCredits: rule.signupCredits,
  };
}
