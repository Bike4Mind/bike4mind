import { IMongoDocument } from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export const LAKE_CONNECTOR_CLAIM_KINDS = ['github', 'googleDrive'] as const;
export type LakeConnectorClaimKind = (typeof LAKE_CONNECTOR_CLAIM_KINDS)[number];

/**
 * Which connector owns a data lake. Each connector model's own per-lake unique index only stops a
 * second row of that same model, so this one doc per lake is what makes "one source per lake" atomic
 * across connector kinds. `connectionId` is the owning connector row's _id.
 */
export interface ILakeConnectorClaim {
  lakeId: string;
  kind: LakeConnectorClaimKind;
  connectionId: string;
  claimedAt: Date;
}

export type ILakeConnectorClaimDocument = ILakeConnectorClaim & IMongoDocument;

export type LakeConnectorClaimHolder = Pick<ILakeConnectorClaim, 'kind' | 'connectionId' | 'claimedAt'>;

// holder is null when the claim kept changing hands between our insert and read (two tries).
export type LakeConnectorClaimResult =
  { acquired: true } | { acquired: false; holder: LakeConnectorClaimHolder | null };

// No softDeletePlugin: a tombstone would keep the unique lakeId and block the next connect.
const LakeConnectorClaimSchema = new Schema<ILakeConnectorClaimDocument>(
  {
    lakeId: {
      type: String,
      required: true,
      validate: { validator: (v: string) => mongoose.isObjectIdOrHexString(v), message: 'lakeId must be an ObjectId' },
    },
    kind: { type: String, enum: LAKE_CONNECTOR_CLAIM_KINDS, required: true },
    connectionId: { type: String, required: true },
    claimedAt: { type: Date, required: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

LakeConnectorClaimSchema.index({ lakeId: 1 }, { unique: true, name: 'lake_connector_claim_lake_id' });
LakeConnectorClaimSchema.index({ connectionId: 1 }, { unique: true, name: 'lake_connector_claim_connection_id' });

export interface ILakeConnectorClaimModel extends Model<ILakeConnectorClaimDocument> {}

export const LakeConnectorClaim: ILakeConnectorClaimModel =
  mongoose.models.LakeConnectorClaim ??
  model<ILakeConnectorClaimDocument>('LakeConnectorClaim', LakeConnectorClaimSchema);

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

class LakeConnectorClaimRepository extends BaseRepository<ILakeConnectorClaimDocument> {
  /**
   * Insert the lake's claim, or report who holds it. One retry covers a holder released between our
   * failed insert and the read.
   */
  async tryAcquire(claim: Omit<ILakeConnectorClaim, 'claimedAt'>): Promise<LakeConnectorClaimResult> {
    // autoIndex builds lazily; the unique index must exist before the first insert or two can land.
    await this.model.init();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.model.create({ ...claim, claimedAt: new Date() });
        return { acquired: true };
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
      }
      const holder = await this.model.findOne({ lakeId: claim.lakeId }).lean();
      if (holder) {
        return {
          acquired: false,
          holder: { kind: holder.kind, connectionId: holder.connectionId, claimedAt: holder.claimedAt },
        };
      }
    }
    return { acquired: false, holder: null };
  }

  async findByLakeId(lakeId: string): Promise<LakeConnectorClaimHolder | null> {
    const claim = await this.model.findOne({ lakeId }).lean();
    return claim ? { kind: claim.kind, connectionId: claim.connectionId, claimedAt: claim.claimedAt } : null;
  }

  /** Compare-and-swap a stale holder out. False when another request took it over or released it first. */
  async takeOver(
    lakeId: string,
    staleConnectionId: string,
    next: Pick<ILakeConnectorClaim, 'kind' | 'connectionId'>
  ): Promise<boolean> {
    const taken = await this.model.findOneAndUpdate(
      { lakeId, connectionId: staleConnectionId },
      { $set: { kind: next.kind, connectionId: next.connectionId, claimedAt: new Date() } }
    );
    return taken !== null;
  }

  // Release is keyed by connectionId, never by lake: after a takeover the lake's claim belongs to a successor.
  async releaseByConnectionId(connectionId: string): Promise<boolean> {
    const res = await this.model.deleteOne({ connectionId });
    return (res?.deletedCount ?? 0) > 0;
  }

  async releaseByConnectionIds(connectionIds: string[]): Promise<number> {
    if (connectionIds.length === 0) return 0;
    const res = await this.model.deleteMany({ connectionId: { $in: connectionIds } });
    return res?.deletedCount ?? 0;
  }
}

export const lakeConnectorClaimRepository = new LakeConnectorClaimRepository(LakeConnectorClaim);

/**
 * For a connector repository's release(), after its row is gone. Swallowed on failure: a claim left
 * behind is stale (its connection no longer exists), and the next connect takes it over. The warning
 * is what tells a grace-window 409 naming a vanished connector apart from a real conflict.
 */
export async function releaseLakeClaimBestEffort(connectionId: string): Promise<void> {
  await lakeConnectorClaimRepository.releaseByConnectionId(connectionId).catch((err: unknown) => {
    console.warn(
      `releaseLakeClaimBestEffort: failed to release lake claim for connection ${connectionId}; ` +
        'the stale claim may refuse other connector kinds until its grace window passes',
      err
    );
  });
}

export default LakeConnectorClaim;
