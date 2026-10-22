/**
 * Who a data-lake connector connection (Google Drive folder, GitHub repository) belongs to - the
 * tenant scope every owner-scoped repository accessor filters on. An organization connection feeds an
 * org lake and is managed by the org's owners/managers; a user (personal) connection feeds a lake its
 * creator owns alone, and carries no organizationId - its owner is `connectedBy`.
 */
export type LakeConnectionOwner = { kind: 'organization'; organizationId: string } | { kind: 'user'; userId: string };

/** The owner of an existing connection: its organization, else the user who connected it. */
export function lakeConnectionOwnerOf(connection: {
  organizationId?: string | null;
  connectedBy: string;
}): LakeConnectionOwner {
  return connection.organizationId
    ? { kind: 'organization', organizationId: connection.organizationId }
    : { kind: 'user', userId: connection.connectedBy };
}

/** Whether two owners name the same tenant. */
export function isSameLakeConnectionOwner(a: LakeConnectionOwner, b: LakeConnectionOwner): boolean {
  if (a.kind === 'organization') return b.kind === 'organization' && a.organizationId === b.organizationId;
  return b.kind === 'user' && a.userId === b.userId;
}

/**
 * The owner a connection to this lake must have: the lake's organization, else the lake's creator.
 * Takes `null`/`''` as no org, matching how org-less lakes persist (see DataLakeModel).
 */
export function lakeConnectionOwnerForLake(lake: {
  organizationId?: string | null;
  createdByUserId: string;
}): LakeConnectionOwner {
  return lake.organizationId
    ? { kind: 'organization', organizationId: lake.organizationId }
    : { kind: 'user', userId: lake.createdByUserId };
}
