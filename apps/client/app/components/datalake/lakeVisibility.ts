/**
 * The single derivation of a lake's visibility label.
 *
 * Three surfaces render this (the manager's detail panel, the page's lake header, and the page's
 * lake rail) and they must agree: the rail and the header can show the same lake side by side, so
 * two independent ternaries would eventually disagree about the same document. The rail wants a
 * compact form, which is why the short label lives here too rather than becoming a fourth rule.
 *
 * Precedence matches the tri-state the settings form writes: public wins over org, org over
 * personal. Note this describes the lake's SCOPE, not who owns it - a stranger's private lake seen
 * by an admin still reads "Private"; ownership is marked separately (see `isOwn`).
 */
export type LakeVisibilityScope = { organizationId?: string; isPublic?: boolean };

export function lakeVisibilityLabel(lake: LakeVisibilityScope): string {
  if (lake.isPublic) return 'Public';
  return lake.organizationId ? 'Organization' : 'Private';
}

/** Compact form for dense rows. Same precedence, shorter words. */
export function lakeVisibilityLabelShort(lake: LakeVisibilityScope): string {
  if (lake.isPublic) return 'Public';
  return lake.organizationId ? 'Org' : 'Private';
}
