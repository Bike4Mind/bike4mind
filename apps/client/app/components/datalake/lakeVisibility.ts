import { DATA_LAKES as BUILT_IN_LAKES, type DataLakeStatus } from '@bike4mind/common';

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

/**
 * Whether to offer the Drive connect control for a lake.
 *
 * Mirrors the server gate (authorizeLakeDriveAccess): an org lake needs an org owner/manager, a
 * personal lake needs its CREATOR - the connection syncs on that user's own Google grant, and lake
 * membership (and the ingest's admin-actor writes) is anchored to `createdByUserId`, not the
 * effective owner, so a personal lake gates on `isCreator` rather than `isOwn`. The status route
 * 404s outside the gate, so offering it there is a control that can only fail. Every render site
 * (SelectedLakeHeader, the wizard's SourceSelectionStep, the lakeSources registry) derives the gate here -
 * they drifted once when each held its own copy of the expression.
 *
 * Absent fields fail closed: an unknown manage or creator status renders no control.
 */
export const canConnectLakeDrive = (lake: {
  organizationId?: string | null;
  canManage?: boolean;
  isCreator?: boolean;
}): boolean => (lake.organizationId ? !!lake.canManage : !!lake.isCreator);

export const DRAFT_LAKE_TOOLTIP = 'Draft - not grounding answers until published';

/**
 * Only 'active' lakes ground answers. A missing status means a pre-status-field user lake (draft),
 * except built-in registry lakes, which always serve.
 */
export function isDraftLake(lake: LakeVisibilityScope & { status?: DataLakeStatus | null }): boolean {
  return lake.status === 'draft' || (!lake.status && !isBuiltInLake(lake));
}
