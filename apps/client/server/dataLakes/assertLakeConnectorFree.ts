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

const CONNECTOR_KINDS = Object.keys(CONNECTORS) as LakeConnectorKind[];

/**
 * One source per lake: throw a ConflictError naming the existing source when the lake is already
 * bound to any connector. Shared by every connector's connect route so the rule cannot drift, and
 * deliberately flag-free - a connector whose feature flag is off still owns the lake it is bound to.
 * Bound means a row exists, enabled or not: a disabled row still holds that model's per-lake unique
 * index, so the lake is not free.
 *
 * Fail-closed: every kind in CONNECTORS is checked, so a new connector is refused everywhere the
 * moment it is registered. `except` exempts the caller's own kind when that route already resolves
 * same-kind reconnects itself (Drive: same-folder reuse plus the folder/lake unique indexes).
 */
export async function assertLakeConnectorFree(
  lakeId: string,
  options: { except?: LakeConnectorKind } = {}
): Promise<void> {
  const kinds = CONNECTOR_KINDS.filter(kind => kind !== options.except);
  const bound = await Promise.all(kinds.map(kind => CONNECTORS[kind].findByDataLakeIdAny(lakeId)));
  const conflict = kinds.find((_, index) => bound[index]);
  if (conflict) {
    throw new ConflictError(CONNECTORS[conflict].conflictMessage);
  }
}
