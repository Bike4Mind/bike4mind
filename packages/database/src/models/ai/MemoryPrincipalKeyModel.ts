import mongoose, { Model, Schema } from 'mongoose';
import { IMongoDocument } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'MemoryPrincipalKey';

/**
 * The keyring for Mementos 2.0 crypto-shred. One data-encryption key (DEK) per principal; the
 * principal's fact ciphertext in the ledger can only be read with it. "Delete my data" = destroy
 * this key (`destroy`), after which every fact - including any in old DB backups - is permanently
 * unreadable, while the hash chain still verifies (it binds commitments, not plaintext).
 *
 * The stored `dek` is opaque to this package: the app-server layer may envelope-wrap it under a
 * master secret before it lands here. This model just holds and, on request, forgets it.
 */
export interface IMemoryPrincipalKey extends IMongoDocument {
  principalKind: 'user' | 'agent' | 'org' | 'system';
  principalId: string;
  ownerUserId: string;
  /** The (possibly envelope-wrapped) data-encryption key, base64. Opaque here. */
  dek: string;
}

interface IMemoryPrincipalKeyModel extends Model<IMemoryPrincipalKey> {}

const MemoryPrincipalKeySchema = new Schema<IMemoryPrincipalKey>(
  {
    principalKind: { type: String, enum: ['user', 'agent', 'org', 'system'], required: true },
    principalId: { type: String, required: true },
    ownerUserId: { type: String, required: true },
    dek: { type: String, required: true },
  },
  { timestamps: true }
);

// One key per principal. Unique so a concurrent getOrCreate cannot mint two keys for a principal
// (which would make half its facts unreadable). Also the lookup index.
MemoryPrincipalKeySchema.index({ principalKind: 1, principalId: 1 }, { unique: true });

class MemoryPrincipalKeyRepository extends BaseRepository<IMemoryPrincipalKey> {
  constructor(model: mongoose.Model<IMemoryPrincipalKey>) {
    super(model);
  }

  /**
   * Return the principal's key, minting `candidateDek` if none exists yet. Race-safe: the unique
   * index + `$setOnInsert` upsert guarantee a single key even under concurrent first writes (the
   * loser reads the winner's key). The caller generates the candidate so this package never sees a
   * raw key it did not already hold.
   */
  async getOrCreate(
    principalKind: IMemoryPrincipalKey['principalKind'],
    principalId: string,
    ownerUserId: string,
    candidateDek: string
  ): Promise<string> {
    const doc = await this.model.findOneAndUpdate(
      { principalKind, principalId },
      { $setOnInsert: { principalKind, principalId, ownerUserId, dek: candidateDek } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return doc.dek;
  }

  /** The principal's key, or null once it has been destroyed (or never existed). */
  async findDek(principalKind: IMemoryPrincipalKey['principalKind'], principalId: string): Promise<string | null> {
    const doc = await this.model.findOne({ principalKind, principalId }).select('dek').lean<{ dek: string } | null>();
    return doc?.dek ?? null;
  }

  /** Destroy the principal's key - the irreversible act of crypto-shred. */
  async destroy(principalKind: IMemoryPrincipalKey['principalKind'], principalId: string): Promise<void> {
    await this.model.deleteOne({ principalKind, principalId });
  }
}

const MemoryPrincipalKeyModel: IMemoryPrincipalKeyModel =
  (mongoose.models[ModelName] as IMemoryPrincipalKeyModel) ||
  mongoose.model<IMemoryPrincipalKey, IMemoryPrincipalKeyModel>(ModelName, MemoryPrincipalKeySchema);

export const memoryPrincipalKeyRepository = new MemoryPrincipalKeyRepository(MemoryPrincipalKeyModel);

export default MemoryPrincipalKeyModel;
