import type { LakeConnectionOwner } from '@bike4mind/common';

/**
 * The tenant filter for a lake connector's owner-scoped accessor (Drive and GitHub connections). A
 * personal connection is one with no org, owned by the user who connected it; `organizationId: null`
 * also matches the field being absent, which is how a personal row persists.
 */
export function lakeConnectionOwnerFilter(owner: LakeConnectionOwner): Record<string, unknown> {
  return owner.kind === 'organization'
    ? { organizationId: owner.organizationId }
    : { organizationId: null, connectedBy: owner.userId };
}
