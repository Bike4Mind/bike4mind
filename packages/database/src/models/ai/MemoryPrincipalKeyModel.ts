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
   * ABSENT means this row is a TOMBSTONE, not that the row is malformed - see `destroy`.
   */
  dek?: string;
  /**
   * When the key was LAST destroyed, retained for the life of the row - a lift mints a new `dek`
   * beside it rather than clearing it. This is the fence `getOrCreate` compares a caller's start time
   * against, so work already in flight when a shred landed cannot mint OR read its way back into a
   * live key.
   *
   * Retention is load-bearing, not bookkeeping. Clearing it on a lift erased the only evidence that a
   * shred had happened, so the fence went blind to that shred the moment the principal legitimately
   * wrote again. A live `dek` alongside a set `destroyedAt` is therefore the NORMAL steady state
   * after any erase-then-rewrite, and a row with both is not malformed.
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
   * The fence applies on BOTH paths. The fast path reads `destroyedAt` alongside the key and refuses
   * a live key whose last shred is not strictly older than `startedAt`, so a caller whose work began
   * before a shred cannot be handed a key that something else re-minted after it. That interleaving
   * needs no exotic concurrency - an ordinary erase-then-write, or a redelivered background job whose
   * work predates the erase, produces it - which is exactly why the stamp is retained rather than
   * cleared.
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
    // Both reads below go through the fence, not just the first: the E11000 re-read can land after a
    // concurrent lift, and an unfenced read there would hand back the same re-minted key.
    const fencedRead = async (): Promise<string | null> => {
      const state = await this.findKeyState(principalKind, principalId);
      if (!state) return null;
      if (state.destroyedAt && state.destroyedAt.getTime() >= startedAt.getTime()) return null;
      return state.dek;
    };

    const live = await fencedRead();
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
          // The `$exists: false` arm is unreachable in steady state and so cannot be covered by a test:
          // no writer produces a row with neither `dek` nor `destroyedAt`, since `destroy` only ever
          // unsets `dek` while setting the stamp. It matches a row mid-insert, and is kept so the filter
          // does not silently depend on that invariant holding forever.
          //
          // Strict on purpose. Timestamps collide at millisecond resolution, so a shred stamped in the
          // same millisecond as a run's start is genuinely ambiguous - and the two ways to be wrong are
          // not symmetric: letting it through can resurface data the user erased, while refusing it
          // only costs one run that writes nothing and is retried. Fail closed.
          $or: [{ destroyedAt: { $exists: false } }, { destroyedAt: { $lt: startedAt } }],
        },
        // `destroyedAt` is deliberately NOT unset: it stays as the monotone record of the last shred
        // so the fenced read above keeps working after this lift.
        { $set: { principalKind, principalId, ownerUserId, dek: candidateDek } },
        // runValidators so the principalKind enum actually gates this upsert - the only production
        // write path for a key. Without it an unknown kind would mint a key the ledger enum rejects.
        { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
      );
      return doc.dek ?? null;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      // Either a concurrent first-write won the insert race - read its key - or the row exists and the
      // filter refused it, which is a fence block and the correct answer is null. A fenced read
      // reports a tombstone - and a key re-minted after this work began - as null, so both collapse
      // to one re-read.
      return fencedRead();
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
   * The principal's key AND the stamp of its last shred - what `getOrCreate` fences against.
   *
   * Kept separate from `findDek` deliberately. `findDek` answers "is there a readable key" for the
   * DECRYPT path, which needs no fence: reading a key that exists resurrects nothing. Only the WRITE
   * path has to know whether a shred has landed since its work began, so only it pays for the wider
   * projection and the extra branch.
   */
  async findKeyState(
    principalKind: IMemoryPrincipalKey['principalKind'],
    principalId: string
  ): Promise<{ dek: string | null; destroyedAt: Date | null } | null> {
    const doc = await this.model
      .findOne({ principalKind, principalId })
      .select('dek destroyedAt')
      .lean<{ dek?: string; destroyedAt?: Date } | null>();
    if (!doc) return null;
    return { dek: doc.dek ?? null, destroyedAt: doc.destroyedAt ?? null };
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
    const tombstone = { $unset: { dek: 1 }, $set: { destroyedAt: new Date() } };
    try {
      // Upsert, so an erase issued before the principal's first-ever key still leaves a fence. As a
      // plain update this was a silent no-op on a missing row, and a first mint already in flight had
      // nothing to be refused by - it inserted its key and wrote under it after the erase.
      //
      // The inserted row carries no `ownerUserId` (this method is not told one, and a tombstone does
      // not need it); the next legitimate mint `$set`s it alongside the new key.
      await this.model.updateOne({ principalKind, principalId }, tombstone, { upsert: true });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      // A concurrent first-write won the insert race. The row exists now, so stamp it in place -
      // never leave without a tombstone, or the shred is unfenced.
      await this.model.updateOne({ principalKind, principalId }, tombstone);
    }
  }
}

const MemoryPrincipalKeyModel: IMemoryPrincipalKeyModel =
  (mongoose.models[ModelName] as IMemoryPrincipalKeyModel) ||
  mongoose.model<IMemoryPrincipalKey, IMemoryPrincipalKeyModel>(ModelName, MemoryPrincipalKeySchema);

export const memoryPrincipalKeyRepository = new MemoryPrincipalKeyRepository(MemoryPrincipalKeyModel);

export default MemoryPrincipalKeyModel;
