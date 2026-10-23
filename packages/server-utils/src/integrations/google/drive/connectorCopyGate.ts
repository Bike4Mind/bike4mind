import type { IFabFileDocument } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';

/** The lake fields the gate needs to answer "does any OTHER lake still claim this file". */
export interface ConnectorCopyGateLake {
  id: string;
  datalakeTag: string;
}

/** The file fields the gate reads - a structural subset of IFabFileDocument. */
export type ConnectorCopyGateFile = Pick<
  IFabFileDocument,
  'id' | 'userId' | 'users' | 'groups' | 'isGlobalRead' | 'tags'
>;

/**
 * The prefix-arm adapter the caller resolves (the ingest memoizes it per run; the disconnect
 * resolves it once for every orphan). Reusing `findOtherLakeClaims`'s own parameter type keeps
 * this from drifting from the service contract.
 */
type PrefixArmAdapters = Parameters<typeof dataLakeService.findOtherLakeClaims>[2];

export interface ConnectorCopyGateDeps {
  adapters: PrefixArmAdapters;
  ownerStillExists: (ownerId: string) => Promise<boolean>;
}

export type ConnectorCopyDeletionVerdict =
  | { deletable: true; ownerId: string }
  | { deletable: false; reason: 'shared' | 'other-lake' | 'no-owner'; detail: Record<string, unknown> };

/**
 * May this connector-minted copy be permanently deleted? The one gate every hard delete of a
 * Drive-ingested FabFile goes through - ingest's edit-retire, ingest's genuine removal, and the
 * disconnect orphan sweep - so none of them can destroy a copy something else still needs.
 *
 * Three claims keep a copy alive, each because the delete would be global and unrecoverable:
 *
 * - A share (a direct user grant, a group grant, or `isGlobalRead`). The replacement is minted for
 *   the connector's owner alone and carries no shares, so the sharee would be left holding a
 *   notebook reference `getAccessibleFiles` silently drops - a loss of access with no signal and no
 *   recovery. Recoverable staleness beats an unrecoverable loss.
 * - Another lake, under EITHER arm of the membership filter. A file a human curated into a second
 *   lake through that lake's `fileTagPrefix` carries no `datalake:` tag for it, so a meta-tag-only
 *   check would evict a full member of a lake this run has no business touching.
 * - No living owner. `deleteFabFile` throws on a missing actor, and running as anyone else either
 *   denies (leaving an orphan) or takes its self-unshare branch and mutates the file instead of
 *   reaping it. Such a copy is left unpicked-but-alive rather than failing the whole run.
 *
 * The caller must pass the tags/owner that SURVIVE its own membership write (the ingest re-reads
 * after its unpick), so the answer is about who is left rather than who was there before.
 */
export const evaluateConnectorCopyDeletion = async (
  copy: ConnectorCopyGateFile,
  lake: ConnectorCopyGateLake,
  { adapters, ownerStillExists }: ConnectorCopyGateDeps
): Promise<ConnectorCopyDeletionVerdict> => {
  const shareClaims = {
    users: (copy.users ?? []).length,
    groups: (copy.groups ?? []).length,
    globalRead: !!copy.isGlobalRead,
  };
  if (shareClaims.users > 0 || shareClaims.groups > 0 || shareClaims.globalRead) {
    return { deletable: false, reason: 'shared', detail: shareClaims };
  }

  const tagNames = (copy.tags ?? []).map(tag => tag?.name).filter((name): name is string => typeof name === 'string');

  const claims = await dataLakeService.findOtherLakeClaims({ userId: copy.userId, tagNames }, lake, adapters);
  if (dataLakeService.hasOtherLakeClaim(claims)) {
    return {
      deletable: false,
      reason: 'other-lake',
      detail: { otherLakeTags: claims.metaTagNames, otherLakeIds: claims.prefixArmLakes.map(other => other.id) },
    };
  }

  const ownerId = copy.userId;
  if (!ownerId || !(await ownerStillExists(ownerId))) {
    return { deletable: false, reason: 'no-owner', detail: { ownerId } };
  }

  return { deletable: true, ownerId };
};
