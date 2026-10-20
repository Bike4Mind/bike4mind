/**
 * Names for the per-org Claude Code plugin marketplace served from the Skill Market
 * (apps/client/pages/api/v1/skills/market/*). Shared so the settings snippet the client shows uses
 * the same marketplace key the feed serves.
 */

/** Lowercase `[a-z0-9-]`, the shape Claude Code expects of marketplace, plugin and skill names. */
export const claudeNameSlug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** A skill's plugin/folder name; `skill` when the name has nothing to slug (e.g. all non-ASCII). */
export const claudeSkillNameFor = (skillName: string): string => claudeNameSlug(skillName) || 'skill';

/**
 * `b4m-<org-name-slug>`. The `b4m-` prefix keeps clear of Claude Code's reserved marketplace names.
 * Renaming the org renames the marketplace, so users then have to add it again.
 */
export function claudeMarketplaceNameFor(org: { id: string; name?: string }): string {
  const name = claudeNameSlug(org.name ?? '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return name ? `b4m-${name}` : `b4m-org-${org.id.slice(-8)}`;
}

/**
 * `<skill-name-slug>-<listing id tail>`. Depends on the listing alone, so the dialog can show it
 * without knowing the other listings, and delisting one listing never renames another's plugin
 * (which the feed's `forceRemoveDeletedPlugins` would uninstall). 8 hex chars reach past the
 * ObjectId counter into its per-process random bytes, so a clash between same-named listings is negligible.
 */
export const claudePluginNameFor = (listingName: string, listingId: string): string =>
  `${claudeSkillNameFor(listingName)}-${listingId.slice(-8)}`;
