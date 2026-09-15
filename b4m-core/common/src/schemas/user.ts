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

/**
 * Response-boundary schemas for the User entity (RFC #483). These are the single
 * source of truth for the SHAPE of a user in an API response: `respond()`
 * (apps/client/server/utils/respond.ts) runs `.parse()` before `res.json`, so any
 * field not listed here is stripped -- accidental over-exposure becomes structurally
 * impossible, not review-dependent -- and a shape/type mismatch fails loud.
 *
 * These validate the PRE-serialization object (what a handler hands to `res.json`),
 * so `Date` fields are `z.date()`; `res.json` performs the Date -> ISO-string
 * conversion afterwards. The inferred types are the server-side truth; a client
 * consuming the JSON receives those Dates as strings.
 *
 * Keep these in lockstep with the serializers in
 * b4m-core/common/src/serializers/toSafeUser.ts, which produce the objects these parse.
 */

/**
 * Mirrors `toSafeUser()`'s allowlist output. The scope-conditional fields
 * (`email` for self/same-org, `isBanned` for same-org) are optional so this one
 * schema validates all three `SafeUserScope`s.
 */
export const safeUserResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  username: z.string(),
  photoUrl: z.string().nullable(),
  isOnline: z.boolean().optional(),
  lastActiveAt: z.date().optional(),
  email: z.string().nullable().optional(),
  isBanned: z.boolean().optional(),
});
export type SafeUser = z.infer<typeof safeUserResponseSchema>;

/** Array form for `toSafeUsers()` list endpoints (org members, pending users). */
export const safeUsersResponseSchema = z.array(safeUserResponseSchema);

/**
 * Mirrors `toPublicProfile()` (pages/api/users/[id]/index.ts): the fields safe to
 * expose to any authenticated user about ANOTHER user. Deliberately excludes
 * email, isAdmin, financial data, tokens, security questions, and admin notes.
 */
export const publicUserProfileResponseSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  photoUrl: z.string().nullable(),
  level: z.string(),
  role: z.string().nullable(),
  team: z.string().nullable(),
  lastActiveAt: z.date().optional(),
  isOnline: z.boolean(),
});
export type PublicUserProfile = z.infer<typeof publicUserProfileResponseSchema>;
