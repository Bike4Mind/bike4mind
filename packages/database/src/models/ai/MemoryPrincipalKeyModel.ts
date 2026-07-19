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
   * Return the principal's key, minting `candidateDek` if none exists yet. Race-safe: Mongo does NOT
   * serialize concurrent upserts, so two first-writes for the same new principal both attempt the
   * insert and the unique index rejects the loser with E11000 - we catch that and re-read the winner's
   * key (mirroring MemoryLedgerEventModel.tryInsert). The unique index still guarantees a single key;
   * this just turns the expected collision into a read instead of a thrown 500 / dropped fact. The
   * caller generates the candidate so this package never sees a raw key it did not already hold.
   */
  async getOrCreate(
    principalKind: IMemoryPrincipalKey['principalKind'],
    principalId: string,
    ownerUserId: string,
    candidateDek: string
  ): Promise<string> {
    try {
      const doc = await this.model.findOneAndUpdate(
        { principalKind, principalId },
        { $setOnInsert: { principalKind, principalId, ownerUserId, dek: candidateDek } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      return doc.dek;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      // The concurrent first-write that lost the insert race: the winner's key now exists, read it.
      const existing = await this.findDek(principalKind, principalId);
      if (existing) return existing;
      throw err; // 11000 with no readable key back would be a genuine anomaly - do not swallow it.
    }
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
