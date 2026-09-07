import mongoose, { Model, Schema } from 'mongoose';
import { IMongoDocument } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';
import { MEMORY_PRINCIPAL_KINDS, type MemoryPrincipalKind } from './MemoryLedgerEventModel';

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
  principalKind: MemoryPrincipalKind;
  principalId: string;
  ownerUserId: string;
  /**
   * The (possibly envelope-wrapped) data-encryption key, base64. Opaque here.
   *
   * ABSENT means this row is a TOMBSTONE, not that the row is malformed - see `destroy`. Exactly one
   * of `dek` / `destroyedAt` is set on any row.
   */
  dek?: string;
  /**
   * When the key was destroyed. Present only on a tombstone. This is the fence `getOrCreate` compares
   * a caller's start time against, so that work already in flight when a shred landed cannot mint its
   * way back into a live key.
   */
  destroyedAt?: Date;
}

interface IMemoryPrincipalKeyModel extends Model<IMemoryPrincipalKey> {}

const MemoryPrincipalKeySchema = new Schema<IMemoryPrincipalKey>(
  {
    principalKind: { type: String, enum: MEMORY_PRINCIPAL_KINDS, required: true },
    principalId: { type: String, required: true },
    ownerUserId: { type: String, required: true },
    // NOT required: a tombstone row carries no dek. The pair is the invariant, not either field
    // alone - see IMemoryPrincipalKey.dek.
    dek: { type: String },
    destroyedAt: { type: Date },
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
   * Return the principal's key, minting `candidateDek` if none exists yet - UNLESS the key was
   * destroyed after `startedAt`, in which case this returns null and the caller must not write.
   *
   * The null is the whole point. This used to be a plain `$setOnInsert` upsert over a hard-deleted
   * row, so an append that raced a crypto-shred silently MINTED A FRESH KEY and the facts it wrote
   * decrypted normally, were never marked shredded, and were served by recall. "Erase my data"
   * returned success while work already in flight put erased content back. Nothing failed closed.
   *
   * `startedAt` is what makes the guard a fence rather than a permanent block: it is the moment the
   * caller's unit of work began (a run's lease claim, a request's arrival). A shred stamped AFTER
   * that means this work predates the erase and must be refused; a shred stamped BEFORE it is an
   * ordinary already-erased principal that a fresh rebuild may legitimately re-key, so the tombstone
   * lifts. One rule covers both, and it needs no separate authorization path.
   *
   * Race-safe in three ways, all of which matter on one principal's row:
   *  - the fast path is a plain read, so the steady state costs no write;
   *  - the mint/lift is a single conditional update whose FILTER encodes the fence, so two runs
   *    cannot both lift one tombstone;
   *  - the upsert can still collide (a concurrent first-write, or a filter that does not match
   *    because the fence blocks it), and E11000 is resolved by re-reading rather than thrown -
   *    mirroring MemoryLedgerEventModel.tryInsert. The unique index remains the guarantee that a
   *    principal never holds two keys, which would make half its facts unreadable.
   *
   * The caller generates the candidate so this package never sees a raw key it did not already hold.
   */
  async getOrCreate(
    principalKind: IMemoryPrincipalKey['principalKind'],
    principalId: string,
    ownerUserId: string,
    candidateDek: string,
    startedAt: Date
  ): Promise<string | null> {
    const live = await this.findDek(principalKind, principalId);
    if (live) return live;

    try {
      const doc = await this.model.findOneAndUpdate(
        {
          principalKind,
          principalId,
          dek: { $exists: false },
          // Absent destroyedAt = never destroyed (or a row mid-insert). `$lt` is what lifts a tombstone
          // raised STRICTLY before this work began.
          //
          // Strict on purpose. Timestamps collide at millisecond resolution, so a shred stamped in the
          // same millisecond as a run's start is genuinely ambiguous - and the two ways to be wrong are
          // not symmetric: letting it through can resurface data the user erased, while refusing it
          // only costs one run that writes nothing and is retried. Fail closed.
          $or: [{ destroyedAt: { $exists: false } }, { destroyedAt: { $lt: startedAt } }],
        },
        { $set: { principalKind, principalId, ownerUserId, dek: candidateDek }, $unset: { destroyedAt: 1 } },
        // runValidators so the principalKind enum actually gates this upsert - the only production
        // write path for a key. Without it an unknown kind would mint a key the ledger enum rejects.
        { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
      );
      return doc.dek ?? null;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      // Either a concurrent first-write won the insert race - read its key - or the row exists and the
      // filter refused it, which is a fence block and the correct answer is null. findDek reports a
      // tombstone as null already, so both collapse to one re-read.
      return this.findDek(principalKind, principalId);
    }
  }

  /**
   * The principal's key, or null once it has been destroyed (or never existed).
   *
   * A tombstone row reads back as null here for free: the row survives with `dek` unset, so the
   * existing `?? null` already reports it as no key. Nothing on the READ side had to change.
   */
  async findDek(principalKind: IMemoryPrincipalKey['principalKind'], principalId: string): Promise<string | null> {
    const doc = await this.model.findOne({ principalKind, principalId }).select('dek').lean<{ dek?: string } | null>();
    return doc?.dek ?? null;
  }

  /**
   * Destroy the principal's key - the irreversible act of crypto-shred.
   *
   * An in-place update that leaves a TOMBSTONE, never a delete. The key itself is genuinely gone
   * (`$unset`), so the shred guarantee is unchanged: every fact sealed under it, in the live DB and in
   * any backup, is permanently unreadable. What the surviving row adds is the ability to say WHEN, so
   * `getOrCreate` can refuse to re-key for work that was already running - a hard delete left no
   * evidence a shred had ever happened, which is precisely why the append path could mint over it.
   *
   * This also puts the keyring on the same footing as the ledger it protects, where a shred has always
   * been an in-place update that preserves the hash chain rather than a delete.
   *
   * The empty-id guard is not defensive noise: mongoose STRIPS undefined keys out of a query filter,
   * so `destroy('lake', undefined)` would degrade to an unscoped write and shred one arbitrary
   * tenant's lake key. Every caller happens to check first; this keeps the invariant local to the only
   * method that cannot be undone.
   */
  async destroy(principalKind: IMemoryPrincipalKey['principalKind'], principalId: string): Promise<void> {
    if (!principalId) throw new Error('destroy requires a principalId - refusing an unscoped key destroy');
    await this.model.updateOne(
      { principalKind, principalId },
      { $unset: { dek: 1 }, $set: { destroyedAt: new Date() } }
    );
  }
}

const MemoryPrincipalKeyModel: IMemoryPrincipalKeyModel =
  (mongoose.models[ModelName] as IMemoryPrincipalKeyModel) ||
  mongoose.model<IMemoryPrincipalKey, IMemoryPrincipalKeyModel>(ModelName, MemoryPrincipalKeySchema);

export const memoryPrincipalKeyRepository = new MemoryPrincipalKeyRepository(MemoryPrincipalKeyModel);

export default MemoryPrincipalKeyModel;
