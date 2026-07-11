import mongoose, { Model, Schema } from 'mongoose';
import { IMongoDocument } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'MemoryLedgerEvent';

/**
 * The persisted append-only ledger for Mementos 2.0. One document per event; a principal's chain is
 * the documents sharing its (principalKind, principalId), ordered by `seq`. Beliefs are NOT stored -
 * they are a pure fold of this ledger, recomputed on read (`@bike4mind/memory` foldEvents).
 *
 * Sealing (the content hash + prev-hash chain) is owned by `@bike4mind/memory` and applied in the
 * app-server layer before an event reaches this model, so this package takes no dependency on the
 * memory core. This model is a dumb, race-safe store of already-sealed events. The string unions
 * below mirror `@bike4mind/memory` (kept in sync by review, like deepAgentTypes' EvidenceTier).
 */

export type MemoryEventKind = 'assert' | 'affirm' | 'retract';
export type MemoryPrincipalKind = 'user' | 'agent' | 'org' | 'system';
export type MemoryEvidenceTier = 'engineering-proxy' | 'engineering-scaled' | 'external-facing' | 'human-reviewed';
export type MemorySalience = 'hot' | 'warm' | 'cold';

const MEMORY_EVENT_KINDS: MemoryEventKind[] = ['assert', 'affirm', 'retract'];
const MEMORY_PRINCIPAL_KINDS: MemoryPrincipalKind[] = ['user', 'agent', 'org', 'system'];
const MEMORY_EVIDENCE_TIERS: MemoryEvidenceTier[] = [
  'engineering-proxy',
  'engineering-scaled',
  'external-facing',
  'human-reviewed',
];
const MEMORY_SALIENCES: MemorySalience[] = ['hot', 'warm', 'cold'];

export interface IMemoryLedgerEvent extends IMongoDocument {
  // --- scope ---
  /** Whose memory this belongs to (the principal), independent of who authored the event. */
  principalKind: MemoryPrincipalKind;
  principalId: string;
  /** Access-control scope: the user permitted to read this chain. */
  ownerUserId: string;
  /** Monotonic chain position within (principalKind, principalId); 0 is the genesis event. */
  seq: number;
  // --- sealed event (content-addressed; see @bike4mind/memory) ---
  kind: MemoryEventKind;
  subject: string;
  /** Plaintext fact - only for events written before at-rest encryption; new events use `factCipher`. */
  fact?: string;
  /** AES-GCM ciphertext of the fact (base64), decryptable with the principal's key. */
  factCipher?: string;
  /** Initialization vector for `factCipher` (base64). */
  factIv?: string;
  /** GCM auth tag for `factCipher` (base64). */
  factTag?: string;
  evidenceTier?: MemoryEvidenceTier;
  salience?: MemorySalience;
  /** ISO-8601. Part of the content hash, so it is stored verbatim to keep the hash reproducible. */
  at: string;
  sources: string[];
  hash: string;
  prevHash: string | null;
  // --- crypto-shred (see @bike4mind/memory): the chain hashes over `commitment`, not the fact, so
  //     the plaintext `fact` can be removed to honor deletion while the chain still verifies.
  //     Optional so events written before this format read back cleanly. ---
  /** Per-event salt binding the fact into its commitment; not secret. */
  salt?: string;
  /** Salted hash of the fact; what the chain hash actually binds to. */
  commitment?: string;
  /** True once the plaintext fact has been shredded. */
  shredded?: boolean;
}

interface IMemoryLedgerEventModel extends Model<IMemoryLedgerEvent> {}

const MemoryLedgerEventSchema = new Schema<IMemoryLedgerEvent>(
  {
    principalKind: { type: String, enum: MEMORY_PRINCIPAL_KINDS, required: true },
    principalId: { type: String, required: true },
    ownerUserId: { type: String, required: true },
    seq: { type: Number, required: true, min: 0 },
    kind: { type: String, enum: MEMORY_EVENT_KINDS, required: true },
    subject: { type: String, required: true },
    fact: { type: String },
    factCipher: { type: String },
    factIv: { type: String },
    factTag: { type: String },
    evidenceTier: { type: String, enum: MEMORY_EVIDENCE_TIERS },
    salience: { type: String, enum: MEMORY_SALIENCES },
    at: { type: String, required: true },
    sources: { type: [String], default: [] },
    hash: { type: String, required: true },
    prevHash: { type: String, default: null },
    salt: { type: String },
    commitment: { type: String },
    shredded: { type: Boolean },
  },
  { timestamps: true }
);

// --- Indexes ---
// The chain's spine. Unique so two concurrent appends that both compute the same next seq collide
// (duplicate-key 11000) instead of forking the chain - this is what makes append race-safe. Also
// serves the ordered read of a principal's chain.
MemoryLedgerEventSchema.index({ principalKind: 1, principalId: 1, seq: 1 }, { unique: true });
// Owner-scoped ordered read: a caller lists only chains they own (scope isolation, no existence leak).
MemoryLedgerEventSchema.index({ ownerUserId: 1, principalKind: 1, principalId: 1, seq: 1 });

// --- Repository ---

/** Thrown-free: `tryInsert` returns null on a seq collision so the caller can re-seal and retry. */
class MemoryLedgerRepository extends BaseRepository<IMemoryLedgerEvent> {
  constructor(model: mongoose.Model<IMemoryLedgerEvent>) {
    super(model);
  }

  /** The head (highest seq) of a principal's chain, or null when the chain is empty. */
  async head(principalKind: MemoryPrincipalKind, principalId: string): Promise<{ hash: string; seq: number } | null> {
    const doc = await this.model
      .findOne({ principalKind, principalId })
      .sort({ seq: -1 })
      .select('hash seq')
      .lean<{ hash: string; seq: number } | null>();
    return doc ? { hash: doc.hash, seq: doc.seq } : null;
  }

  /**
   * Insert one already-sealed event at its `seq`. Returns the stored event, or null when the seq
   * was taken by a concurrent append (unique-index 11000) - the signal for the caller to re-read
   * the head, re-seal onto the new tip, and retry. Any other error propagates.
   */
  async tryInsert(
    event: Omit<IMemoryLedgerEvent, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<IMemoryLedgerEvent | null> {
    try {
      const created = await this.model.create(event);
      return created.toObject();
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return null;
      throw err;
    }
  }

  /**
   * A principal's chain in order, restricted to `ownerUserId`. A chain the caller does not own
   * comes back empty (indistinguishable from a nonexistent one) so existence never leaks.
   */
  async listChain(
    principalKind: MemoryPrincipalKind,
    principalId: string,
    ownerUserId: string
  ): Promise<IMemoryLedgerEvent[]> {
    const docs = await this.model.find({ principalKind, principalId, ownerUserId }).sort({ seq: 1 });
    return docs.map(d => d.toObject());
  }

  /**
   * Mark a principal's whole chain shredded and remove every fact payload (plaintext and
   * ciphertext). Belt-and-suspenders to destroying the key: the key alone makes ciphertext
   * unreadable, but clearing the payloads reclaims space and makes the shred explicit. The
   * commitments, hashes, and links are untouched, so the chain still verifies. Returns the count of
   * events affected.
   */
  async markShredded(principalKind: MemoryPrincipalKind, principalId: string, ownerUserId: string): Promise<number> {
    const res = await this.model.updateMany(
      { principalKind, principalId, ownerUserId },
      { $set: { shredded: true }, $unset: { fact: '', factCipher: '', factIv: '', factTag: '' } }
    );
    return res.modifiedCount ?? 0;
  }
}

// --- Model & Export ---

const MemoryLedgerEventModel: IMemoryLedgerEventModel =
  (mongoose.models[ModelName] as IMemoryLedgerEventModel) ||
  mongoose.model<IMemoryLedgerEvent, IMemoryLedgerEventModel>(ModelName, MemoryLedgerEventSchema);

export const memoryLedgerRepository = new MemoryLedgerRepository(MemoryLedgerEventModel);

export default MemoryLedgerEventModel;
