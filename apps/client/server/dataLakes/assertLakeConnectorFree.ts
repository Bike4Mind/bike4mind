import { orgGitHubLakeConnectionRepository, orgGoogleDriveConnectionRepository } from '@bike4mind/database';
import { ConflictError } from '@server/utils/errors';

export type LakeConnectorKind = 'github' | 'googleDrive';

type LakeConnector = {
  findByDataLakeIdAny: (lakeId: string) => Promise<{ id: string } | null>;
  conflictMessage: string;
};

// Key order is check order: when a lake is bound to several kinds, the first one names the conflict.
const CONNECTORS: Record<LakeConnectorKind, LakeConnector> = {
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
 * Every kind in CONNECTORS is checked unless exempted, so a route cannot forget one - but a new
 * connector model is only covered once it is added to CONNECTORS (and LakeConnectorKind) here.
 *
 * `except` skips the caller's own kind when its create already refuses a same-kind second claim with
 * a more specific message (Drive: the targetDataLakeId unique index -> "connected to a different
 * Drive folder"). It plays no part in same-folder reuse, which never reaches this guard.
 */
export async function assertLakeConnectorFree(
  lakeId: string,
  options: { except?: LakeConnectorKind } = {}
): Promise<void> {
  const checked = await Promise.all(
    CONNECTOR_KINDS.filter(kind => kind !== options.except).map(async kind => ({
      kind,
      bound: Boolean(await CONNECTORS[kind].findByDataLakeIdAny(lakeId)),
    }))
  );
  const conflict = checked.find(({ bound }) => bound);
  if (conflict) {
    throw new ConflictError(CONNECTORS[conflict.kind].conflictMessage);
  }
}
