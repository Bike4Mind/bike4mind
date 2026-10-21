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
 * `b4m-org-<org id>`. Id-based rather than name-based because an install is keyed
 * `<plugin>@<marketplace>`, so renaming the org must never rename the marketplace.
 */
export const claudeMarketplaceNameFor = (orgId: string): string => `b4m-org-${orgId}`;
