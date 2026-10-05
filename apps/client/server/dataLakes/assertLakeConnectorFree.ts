import {
  type LakeConnectorClaimHolder,
  lakeConnectorClaimRepository,
  orgGitHubLakeConnectionRepository,
  orgGoogleDriveConnectionRepository,
} from '@bike4mind/database';
import { Types } from 'mongoose';
import { ConflictError } from '@server/utils/errors';

export type LakeConnectorKind = 'github' | 'googleDrive';

type LakeConnector = {
  findByDataLakeIdAny: (lakeId: string) => Promise<{ id: string } | null>;
  findByIdAny: (id: string) => Promise<{ id: string } | null>;
  conflictMessage: string;
};

// Key order is check order: when a lake is bound to several kinds, the first one names the conflict.
const CONNECTORS: Record<LakeConnectorKind, LakeConnector> = {
  github: {
    findByDataLakeIdAny: lakeId => orgGitHubLakeConnectionRepository.findByDataLakeIdAny(lakeId),
    findByIdAny: id => orgGitHubLakeConnectionRepository.findById(id),
    conflictMessage: 'This data lake is already connected to a GitHub repository',
  },
  googleDrive: {
    findByDataLakeIdAny: lakeId => orgGoogleDriveConnectionRepository.findByDataLakeIdAny(lakeId),
    findByIdAny: id => orgGoogleDriveConnectionRepository.findById(id),
    conflictMessage: 'This data lake is already connected to a Google Drive folder',
  },
};

const CONNECTOR_KINDS = Object.keys(CONNECTORS) as LakeConnectorKind[];

/**
 * One source per lake, checked by rows: throw a ConflictError naming the existing source when the
 * lake is already bound to any connector. The atomic rule is withLakeConnectorClaim; this check
 * covers lakes bound before claims existed (row, no claim) and gives GitHub's connect a begin-time
 * refusal before the user leaves for GitHub. Deliberately flag-free - a connector whose feature flag
 * is off still owns the lake it is bound to. Bound means a row exists, enabled or not: a disabled row
 * still holds that model's per-lake unique index, so the lake is not free.
 *
 * Every kind in CONNECTORS is checked unless exempted, so a route cannot forget one - but a new
 * connector model is only covered once it is added to CONNECTORS (and LakeConnectorKind) here.
 *
 * `except` skips the caller's own kind, which withLakeConnectorClaim passes because the claim and the
 * kind's own per-lake unique index already refuse a same-kind second row. `includeClaim` also refuses
 * a live claim (see isClaimLive), for a check run before the claim is attempted.
 */
export async function assertLakeConnectorFree(
  lakeId: string,
  options: { except?: LakeConnectorKind; includeClaim?: boolean } = {}
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
  if (options.includeClaim) {
    const holder = await lakeConnectorClaimRepository.findByLakeId(lakeId);
    if (holder && (await isClaimLive(holder))) {
      throw new ConflictError(CONNECTORS[holder.kind].conflictMessage);
    }
  }
}

// A claim younger than this may belong to a connect whose row is not written yet, so it is never taken over.
export const CLAIM_GRACE_MS = 5 * 60 * 1000;

// A failed best-effort release after a row delete can leave a live-looking claim for up to this window.
async function isClaimLive(holder: LakeConnectorClaimHolder): Promise<boolean> {
  return (
    Date.now() - new Date(holder.claimedAt).getTime() <= CLAIM_GRACE_MS ||
    Boolean(await CONNECTORS[holder.kind].findByIdAny(holder.connectionId))
  );
}

// A second Drive folder on a Drive-claimed lake keeps the more specific message its route always gave.
const SAME_KIND_CONFLICT: Partial<Record<LakeConnectorKind, string>> = {
  googleDrive: 'This data lake is already connected to a different Drive folder',
};

/**
 * Atomically claim the lake for one connector, then run `create` with the connection id the claim
 * was taken under; `create` must write its row with that `_id` (see `withConnectionId`). Throws a
 * ConflictError when another connector holds the lake. A holder is taken over only when it is past
 * CLAIM_GRACE_MS and its connection row no longer exists. Any throw from the legacy-row check or
 * `create` releases the claim before rethrowing.
 */
export async function withLakeConnectorClaim<T>(
  lakeId: string,
  kind: LakeConnectorKind,
  create: (connectionId: string) => Promise<T>
): Promise<T> {
  const connectionId = new Types.ObjectId().toString();
  const result = await lakeConnectorClaimRepository.tryAcquire({ lakeId, kind, connectionId });
  if (!result.acquired) {
    const { holder } = result;
    if (!holder) {
      throw new ConflictError('This data lake is being connected by another request. Try again.');
    }
    const stale = !(await isClaimLive(holder));
    const tookOver =
      stale && (await lakeConnectorClaimRepository.takeOver(lakeId, holder.connectionId, { kind, connectionId }));
    if (!tookOver) {
      throw new ConflictError(
        (holder.kind === kind && SAME_KIND_CONFLICT[kind]) || CONNECTORS[holder.kind].conflictMessage
      );
    }
  }

  try {
    // A lake bound before claims existed has a row but no claim.
    await assertLakeConnectorFree(lakeId, { except: kind });
    return await create(connectionId);
  } catch (error) {
    await lakeConnectorClaimRepository.releaseByConnectionId(connectionId).catch(() => false);
    throw error;
  }
}

/**
 * Give a connector row the `_id` its lake claim was taken under. The repository create types omit
 * `_id`, but Mongoose honors a preset one; Object.assign keeps it off a checked object literal.
 */
export function withConnectionId<D extends object>(connectionId: string, data: D): D & { _id: Types.ObjectId } {
  return Object.assign(data, { _id: new Types.ObjectId(connectionId) });
}
