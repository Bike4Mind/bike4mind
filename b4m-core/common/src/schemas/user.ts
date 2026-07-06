import * as z from 'zod';

export const VALID_USER_TAGS = [
  '',
  'TFG',
  'tfg',
  'Developer',
  'Bike4Mind',
  'Dev',
  'dev',
  'Analyst',
  'analyst',
  'Analysts',
  'analysts',
  'developer',
  'Developers',
  'developers',
  'Customer',
  'customer',
  'Customers',
  'customers',
  'Customer (GenAI)',
  'sharing',
  'Opti',
  'opti',
] as const;
export const UserTagSchema = z.enum(VALID_USER_TAGS);

/**
 * The subset of VALID_USER_TAGS that grant developer status - the single source of
 * truth for "is this a developer tag". Consumed by the client route guard
 * (`userIsDeveloper`) AND by product-surface server access guards, so the UI grant
 * and the API grant can never drift (a stale duplicate caused a fail-open where an
 * uppercase casing granted the API but not the route). Matched case-sensitively
 * against the assignable casings enumerated above - no case-folding, so only tags a
 * user can actually be assigned (per VALID_USER_TAGS) ever qualify.
 */
export const DEVELOPER_USER_TAGS = ['Developer', 'Dev', 'dev', 'developer', 'Developers', 'developers'] as const;

/** True if any of the user's tags grants developer status (case-sensitive; mirrors the route guard exactly). */
export function hasDeveloperUserTag(tags: readonly string[] | null | undefined): boolean {
  const developerTags: readonly string[] = DEVELOPER_USER_TAGS;
  return (tags ?? []).some(tag => developerTags.includes(tag));
}

/**
 * True if any of the user's tags grants Tavern access. Matched case-insensitively
 * against 'tavern' to mirror the sidebar nav gate (`SidenavNav`) exactly.
 */
export function hasTavernUserTag(tags: readonly string[] | null | undefined): boolean {
  return (tags ?? []).some(tag => tag.toLowerCase() === 'tavern');
}

/**
 * True if the user may access the Tavern HUD surface: admins, or holders of the
 * 'tavern' tag. The single source of truth for "can this user reach the Tavern",
 * consumed by BOTH the client route/tab guard AND the server-side API guards
 * (`ensureTavernAccess`), so the UI grant and the API grant can never drift -
 * the same fail-open class that motivated `hasDeveloperUserTag`.
 */
export function canAccessTavern(
  user: { isAdmin?: boolean | null; tags?: readonly string[] | null } | null | undefined
): boolean {
  if (!user) return false;
  return !!user.isAdmin || hasTavernUserTag(user.tags);
}

export enum AuthStrategy {
  Google = 'google',
  Facebook = 'facebook',
  Github = 'github',
  Okta = 'okta',
  SAML = 'saml',
}
