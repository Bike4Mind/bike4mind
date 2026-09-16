/**
 * Reading a per-user experimental-feature flag.
 *
 * The flag lives at `user.preferences.experimentalFeatures`, and its runtime shape is NOT what the
 * type says: `UserModel` declares it `{ type: Map, of: Boolean }`, so a hydrated user carries a
 * Mongoose **Map**, while `UserPreferences` types it as a plain `Record<string, boolean>`. Dot
 * access on a Map silently yields `undefined` - it does not throw, and TypeScript is happy - so a
 * reader written the obvious way reports every flag as OFF and the feature simply never runs.
 *
 * That bug shipped once already: the chat completion gated Mementos V2 on
 * `preferences?.experimentalFeatures?.enableMementosV2`, which is always `undefined` against a Map,
 * so V2 memory was never injected into a prompt even for a user who had opted in. Every reader must
 * go through here.
 */

/**
 * A user-ish object whose experimental-features bag may be a Map, a plain object, or absent.
 * `preferences` is nullable to match `IUserDocument`, whose own type allows null.
 */
export interface HasExperimentalFeatures {
  experimentalFeatures?: unknown;
  preferences?: { experimentalFeatures?: unknown } | null;
}

const readBag = (bag: unknown, flag: string): boolean | undefined => {
  const raw =
    bag instanceof Map
      ? bag.get(flag) // hydrated Mongoose document
      : bag && typeof bag === 'object'
        ? (bag as Record<string, unknown>)[flag] // .lean()/plain JSON
        : undefined;
  return typeof raw === 'boolean' ? raw : undefined;
};

/**
 * True when the user has opted into `flag`. Handles both the hydrated (Map) and plain-object shapes,
 * and falls back to the legacy top-level `experimentalFeatures` bag.
 */
export function isExperimentalFeatureEnabled(user: HasExperimentalFeatures | null | undefined, flag: string): boolean {
  if (!user) return false;
  return (
    readBag(user.preferences?.experimentalFeatures, flag) === true || readBag(user.experimentalFeatures, flag) === true
  );
}

/**
 * The user's EXPLICIT setting for `flag`, or `undefined` when they have never toggled it.
 *
 * Distinct from `isExperimentalFeatureEnabled`, which collapses "never set" to false. A flag whose
 * unset state falls back to an admin-settable default (the `*Default` settings keys) must be able
 * to tell "off" from "never expressed", or every never-toggled user is read as opted out and the
 * admin default stops meaning anything. The preferences bag wins over the legacy top-level one even
 * when it says `false` - an explicit opt-out is the newer signal.
 */
export function readExperimentalFeaturePreference(
  user: HasExperimentalFeatures | null | undefined,
  flag: string
): boolean | undefined {
  if (!user) return undefined;
  return readBag(user.preferences?.experimentalFeatures, flag) ?? readBag(user.experimentalFeatures, flag);
}
