import { DATA_LAKES as BUILT_IN_LAKES } from '@bike4mind/common';

/**
 * The single derivation of a lake's visibility label.
 *
 * Three surfaces render this (the manager's detail panel, the page's lake header, and the page's
 * lake rail) and they must agree: the rail and the header can show the same lake side by side, so
 * two independent ternaries would eventually disagree about the same document. The rail wants a
 * compact form, which is why the short label lives here too rather than becoming a fourth rule.
 *
 * Precedence: built-in wins, then public, then org, then personal. Note this describes the lake's
 * SCOPE, not who owns it - a stranger's private lake seen by an admin still reads "Private";
 * ownership is marked separately (see `isOwn`).
 */
export type LakeVisibilityScope = { id?: string; organizationId?: string; isPublic?: boolean };

/**
 * A static registry lake (`DATA_LAKES`) rather than a user-created document. These have no owner,
 * no org, and are not public opt-ins, so every other arm of the label would call them "Private" -
 * which they are not: they are entitlement-gated shared content nobody owns.
 *
 * Identified by registry membership rather than by inferring from `isOwn`/`organizationId`, because
 * those same values also describe a STRANGER'S private lake as seen by a global admin (whose list
 * is unscoped). Those two cases must not collapse: one is built-in, the other really is private.
 *
 * The registry is extended by premium overlays, so this correctly covers overlay-contributed lakes
 * in a build that has them and silently covers none in the open-core fork.
 */
export const isBuiltInLake = (lake: LakeVisibilityScope): boolean =>
  !!lake.id && BUILT_IN_LAKES.some(registered => registered.id === lake.id);

export function lakeVisibilityLabel(lake: LakeVisibilityScope): string {
  if (isBuiltInLake(lake)) return 'Built-in';
  if (lake.isPublic) return 'Public';
  return lake.organizationId ? 'Organization' : 'Private';
}

/** Compact form for dense rows. Same precedence, shorter words. */
export function lakeVisibilityLabelShort(lake: LakeVisibilityScope): string {
  if (isBuiltInLake(lake)) return 'Built-in';
  if (lake.isPublic) return 'Public';
  return lake.organizationId ? 'Org' : 'Private';
}
