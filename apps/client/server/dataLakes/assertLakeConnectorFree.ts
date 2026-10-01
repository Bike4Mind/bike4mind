import { orgGitHubLakeConnectionRepository, orgGoogleDriveConnectionRepository } from '@bike4mind/database';
import { ConflictError } from '@server/utils/errors';

export type LakeConnectorKind = 'github' | 'googleDrive';

const CONNECTORS: Record<
  LakeConnectorKind,
  { findByDataLakeIdAny: (lakeId: string) => Promise<unknown>; conflictMessage: string }
> = {
  github: {
    findByDataLakeIdAny: lakeId => orgGitHubLakeConnectionRepository.findByDataLakeIdAny(lakeId),
    conflictMessage: 'This data lake is already connected to a GitHub repository',
  },
  googleDrive: {
    findByDataLakeIdAny: lakeId => orgGoogleDriveConnectionRepository.findByDataLakeIdAny(lakeId),
    conflictMessage: 'This data lake is already connected to a Google Drive folder',
  },
};

/**
 * One source per lake: throw a ConflictError naming the existing source when the lake is already
 * bound to any of `kinds`. Shared by every connector's connect route so the rule cannot drift, and
 * deliberately flag-free - a connector whose feature flag is off still owns the lake it is bound to.
 *
 * A route passes the kinds it must refuse: the GitHub connect refuses both, while the Drive connect
 * refuses only GitHub, since its own same-folder reconnect and folder/lake unique indexes handle Drive.
 */
export async function assertLakeConnectorFree(lakeId: string, kinds: readonly LakeConnectorKind[]): Promise<void> {
  const bound = await Promise.all(kinds.map(kind => CONNECTORS[kind].findByDataLakeIdAny(lakeId)));
  const conflict = kinds.find((_, index) => bound[index]);
  if (conflict) {
    throw new ConflictError(CONNECTORS[conflict].conflictMessage);
  }
}
