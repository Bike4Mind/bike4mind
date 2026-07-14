import type { IMemoryLedgerEvent, MemoryPrincipalKind } from '@bike4mind/database';
import { MEMENTO_EMBEDDING_ID } from '@bike4mind/common';
import {
  foldEvents,
  sealEvent,
  type Belief,
  type EvidenceTier,
  type MemoryEvent,
  type MemoryEventInput,
  type MemoryProfile,
  type MemoryStore,
  type Principal,
} from '@bike4mind/memory';
import {
  decryptFact,
  decryptVector,
  encryptFact,
  encryptVector,
  subjectHmac,
  type KeyProvider,
  type SealedFact,
} from './factCipher';

/**
 * The app-server seam between the pure memory core (sealing + fold) and the persisted ledger
 * (`memoryLedgerRepository`). The database package stays dependency-free of `@bike4mind/memory`;
 * the content hash-chain is applied HERE, so the two meet in the app layer.
 *
 * Deps are structural so tests supply a fake repository (no Mongo). `memoryLedgerRepository`
 * satisfies `LedgerRepo` directly.
 */

type NewLedgerEvent = Omit<IMemoryLedgerEvent, 'id' | 'createdAt' | 'updatedAt'>;

export interface LedgerRepo {
  head(principalKind: MemoryPrincipalKind, principalId: string): Promise<{ hash: string; seq: number } | null>;
  tryInsert(event: NewLedgerEvent): Promise<IMemoryLedgerEvent | null>;
  listChain(
    principalKind: MemoryPrincipalKind,
    principalId: string,
    ownerUserId: string,
    options?: { withEmbeddings?: boolean }
  ): Promise<IMemoryLedgerEvent[]>;
  listEmbeddings(
    principalKind: MemoryPrincipalKind,
    principalId: string,
    ownerUserId: string,
    hashes: string[]
  ): Promise<IMemoryLedgerEvent[]>;
  markShredded(principalKind: MemoryPrincipalKind, principalId: string, ownerUserId: string): Promise<number>;
}

// A concurrent append re-reads the head and retries; a handful of attempts absorbs realistic
// contention on one principal's tip. Exceeding it means sustained contention worth surfacing.
const MAX_APPEND_ATTEMPTS = 6;

/**
 * Append one event to a principal's chain, owned by `ownerUserId`. Reads the current head, seals the
 * event onto it (content hash + prev-hash) via the memory core, and inserts it at the next seq. If a
 * concurrent append took that seq (the repository signals it with a null), re-read the head and
 * retry - this is what keeps the chain linear instead of forking under races. Returns the sealed
 * event.
 */
export async function appendMemoryEvent(
  repo: LedgerRepo,
  keys: Pick<KeyProvider, 'getOrCreateDek'>,
  ownerUserId: string,
  input: MemoryEventInput,
  options: {
    /**
     * `input.subject` is ALREADY the HMAC - store it verbatim rather than hashing it again.
     *
     * This exists because the subject a caller reads back OUT of the ledger is the hash: it is never
     * persisted in plaintext, so a folded belief's id is HMAC(subject), and there is no way to invert
     * it. A caller that has found the belief it wants to re-assert (semantic de-dup on the write path)
     * therefore holds the hash, and passing it through the normal path would hash it TWICE - producing
     * a key that matches nothing and silently minting a duplicate belief instead of coalescing.
     */
    subjectIsHashed?: boolean;
  } = {}
): Promise<MemoryEvent> {
  // Fetch the key once (outside the retry loop) and use it to encrypt the fact AND to HMAC the
  // subject. Neither the fact nor the subject is ever persisted in plaintext, so destroying the key
  // later renders both - and any backup of them - unreadable. The HMAC is deterministic, so
  // re-mentions of the same fact still coalesce.
  const dek = await keys.getOrCreateDek(input.principal, ownerUserId);
  const sealedFact: SealedFact | undefined = input.fact !== undefined ? encryptFact(dek, input.fact) : undefined;
  // The embedding is encrypted under the SAME key as the fact: it is a semantic image of that fact,
  // so it must die with it when the key is destroyed (see encryptVector).
  const sealedEmbedding: SealedFact | undefined = input.embedding?.length
    ? encryptVector(dek, input.embedding)
    : undefined;
  const sealedInput: MemoryEventInput = {
    ...input,
    subject: options.subjectIsHashed ? input.subject : subjectHmac(dek, input.subject),
  };

  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    const head = await repo.head(input.principal.kind, input.principal.id);
    const sealed = sealEvent(head?.hash ?? null, sealedInput);
    const stored = await repo.tryInsert({
      principalKind: input.principal.kind,
      principalId: input.principal.id,
      ownerUserId,
      seq: head ? head.seq + 1 : 0,
      kind: sealed.kind,
      subject: sealed.subject,
      factCipher: sealedFact?.cipher,
      factIv: sealedFact?.iv,
      factTag: sealedFact?.tag,
      embeddingCipher: sealedEmbedding?.cipher,
      embeddingIv: sealedEmbedding?.iv,
      embeddingTag: sealedEmbedding?.tag,
      // Stamp the space this vector lives in. The ledger is append-only - this can never be corrected
      // later, so an unstamped or stale-model vector must be ignored at read time rather than trusted.
      ...(sealedEmbedding ? { embeddingModel: MEMENTO_EMBEDDING_ID } : {}),
      evidenceTier: sealed.evidenceTier,
      salience: sealed.salience,
      at: sealed.at,
      sources: sealed.sources ?? [],
      hash: sealed.hash,
      prevHash: sealed.prevHash,
      salt: sealed.salt,
      commitment: sealed.commitment,
    });
    if (stored) return sealed;
  }
  throw new Error('memory ledger append: exceeded retry budget under concurrent contention');
}

/**
 * Rehydrate a stored document into the core's `MemoryEvent` shape, decrypting the fact with the
 * principal's `dek`. A ciphered fact that will not decrypt - because the key was destroyed (shred)
 * or the ciphertext was altered - folds as shredded, so lost content redacts rather than leaks.
 */
function toMemoryEvent(d: IMemoryLedgerEvent, dek: Buffer | null): MemoryEvent {
  let fact = d.fact; // legacy plaintext, for events written before at-rest encryption
  let shredded = d.shredded;
  if (d.factCipher && d.factIv && d.factTag) {
    const plain = dek ? decryptFact(dek, { cipher: d.factCipher, iv: d.factIv, tag: d.factTag }) : null;
    if (plain === null) {
      fact = undefined;
      shredded = true;
    } else {
      fact = plain;
    }
  }

  // Decrypt the embedding under the same key. A destroyed key yields null, so a shredded belief
  // surfaces no vector - the semantic image dies with the fact.
  //
  // A vector from ANOTHER model's space is worse than no vector: cosine against it is noise, and
  // because this ledger belief WINS the union de-dup against its memento twin (mergeStores keeps the
  // first store's belief and only borrows fields it is missing), a stale vector here shadows the
  // twin's freshly re-embedded one. Dropping it is what lets the fresh memento vector through.
  // The ledger cannot be re-embedded in place - it is append-only - so this gate is permanent, not a
  // migration shim.
  const embedding =
    dek && d.embeddingCipher && d.embeddingIv && d.embeddingTag && d.embeddingModel === MEMENTO_EMBEDDING_ID
      ? (decryptVector(dek, { cipher: d.embeddingCipher, iv: d.embeddingIv, tag: d.embeddingTag }) ?? undefined)
      : undefined;

  return {
    principal: { kind: d.principalKind, id: d.principalId },
    kind: d.kind,
    subject: d.subject,
    fact,
    ...(embedding?.length ? { embedding } : {}),
    evidenceTier: d.evidenceTier as EvidenceTier | undefined,
    salience: d.salience,
    at: d.at,
    sources: d.sources,
    hash: d.hash,
    prevHash: d.prevHash,
    salt: d.salt ?? '',
    commitment: d.commitment ?? '',
    shredded,
  };
}

/**
 * A persisted-ledger MemoryStore, owner-scoped. Lists the principal's chain (restricted to
 * `ownerUserId`, so a not-owned or empty chain both read as null - no existence leak), decrypts each
 * fact with the principal's key (fetched once), and folds to a live profile with ACT-R salience as
 * of `now`. Composed ahead of the snapshot adapters, so a principal with no ledger falls through.
 */
/**
 * Pass two of the fold: decrypt and attach the vector for each surviving belief.
 *
 * A belief's `derivedFrom` is the events it was folded from, assert FIRST (an assert resets it; affirms
 * append). The fold's own rule is that the assert's embedding wins and an affirm only backfills a
 * missing one - so taking the first event in `derivedFrom` that carries a usable vector reproduces it
 * exactly. Because our write path asserts, `derivedFrom` is normally a single hash, which is what keeps
 * this fetch small.
 *
 * A vector from another embedding model is skipped for the same reason the memento read path skips one:
 * cosine across two models' spaces is noise, and the ledger cannot be re-embedded in place.
 */
async function attachEmbeddings(
  deps: { ledger: Pick<LedgerRepo, 'listEmbeddings'>; ownerUserId: string },
  principal: Principal,
  beliefs: Belief[],
  dek: Buffer | null
): Promise<void> {
  if (!dek) return; // shredded principal: there is nothing readable to attach

  const live = beliefs.filter(b => !b.shredded);
  const hashes = live.flatMap(b => b.derivedFrom);
  if (hashes.length === 0) return;

  const rows = await deps.ledger.listEmbeddings(principal.kind, principal.id, deps.ownerUserId, hashes);
  const byHash = new Map(rows.map(r => [r.hash, r]));

  for (const belief of live) {
    for (const hash of belief.derivedFrom) {
      const row = byHash.get(hash);
      if (!row?.embeddingCipher || !row.embeddingIv || !row.embeddingTag) continue;
      if (row.embeddingModel !== MEMENTO_EMBEDDING_ID) continue;

      const vector = decryptVector(dek, {
        cipher: row.embeddingCipher,
        iv: row.embeddingIv,
        tag: row.embeddingTag,
      });
      if (vector?.length) {
        belief.embedding = vector;
        break;
      }
    }
  }
}

export function createLedgerMemoryStore(deps: {
  ledger: Pick<LedgerRepo, 'listChain' | 'listEmbeddings'>;
  keys: Pick<KeyProvider, 'getDek'>;
  ownerUserId: string;
  now?: string;
}): MemoryStore {
  return {
    async readProfile(principal: Principal): Promise<MemoryProfile | null> {
      // TWO-PASS, and the reason is the append-only chain: an embedding is ~8KB of ciphertext per
      // event and the chain only ever grows, so pulling every vector means dragging the user's ENTIRE
      // vector history over the wire on every chat turn - most of it belonging to beliefs that were
      // long since superseded and whose vectors the fold decrypts only to discard. Measured against a
      // remote Mongo: 400 events fold in 6.1s with the vectors inline and 0.5s without.
      //
      // So: fold on the cheap metadata first to find out which beliefs actually SURVIVE, then fetch
      // vectors for only those. Cost becomes O(live beliefs) instead of O(events-ever-written).
      const [docs, dek] = await Promise.all([
        deps.ledger.listChain(principal.kind, principal.id, deps.ownerUserId, { withEmbeddings: false }),
        deps.keys.getDek(principal),
      ]);
      if (docs.length === 0) return null;

      const chain = docs.map(d => toMemoryEvent(d, dek));
      const beliefs = foldEvents(chain, { now: deps.now ?? new Date().toISOString() });

      await attachEmbeddings(deps, principal, beliefs, dek);

      return { principal, beliefs };
    },
  };
}

/**
 * Delete a principal's memory (crypto-shred): destroy its data-encryption key so every fact -
 * including any in DB backups - becomes permanently unreadable, then clear the payloads and mark the
 * chain shredded. The hash chain is untouched, so it still verifies; the beliefs fold to redactions.
 * Returns the number of events shredded.
 *
 * This covers the LEDGER only. A user's memory is the ledger UNIONED with their V1 mementos, so on
 * its own this is not "delete my data" - see `purgeUserMemory`.
 */
export async function shredPrincipalMemory(
  repo: Pick<LedgerRepo, 'markShredded'>,
  keys: Pick<KeyProvider, 'destroyDek'>,
  principal: Principal,
  ownerUserId: string
): Promise<number> {
  await keys.destroyDek(principal); // the irreversible act; do it first
  return repo.markShredded(principal.kind, principal.id, ownerUserId);
}

/** The memento-side surface `purgeUserMemory` needs; `mementoRepository` satisfies it. */
export interface MementoPurger {
  deleteAllByUserId(userId: string): Promise<number>;
}

/**
 * Delete a USER's memory for real - both halves of what the unified read serves.
 *
 * Shredding the ledger alone is not deletion. The V2 read is `mergeStores([ledger, mementos])`, so a
 * user whose ledger was shredded still had every V1 memento returned in plaintext - and injected
 * straight back into the next chat prompt. The ledger half is crypto-shredded (its key is destroyed,
 * so even DB backups are unreadable); the memento half has no key to destroy - summary, full prompt
 * and embedding are all plaintext - so it is hard-deleted.
 *
 * Irreversible, owner-scoped, and the ledger is shredded FIRST: if the memento delete then fails,
 * the user is left with less memory rather than a false promise of deletion.
 */
export async function purgeUserMemory(
  repo: Pick<LedgerRepo, 'markShredded'>,
  keys: Pick<KeyProvider, 'destroyDek'>,
  mementos: MementoPurger,
  userId: string
): Promise<{ eventsShredded: number; mementosDeleted: number }> {
  const eventsShredded = await shredPrincipalMemory(repo, keys, { kind: 'user', id: userId }, userId);
  const mementosDeleted = await mementos.deleteAllByUserId(userId);
  return { eventsShredded, mementosDeleted };
}
