import type { IMemoryLedgerEvent, MemoryPrincipalKind } from '@bike4mind/database';
import {
  foldEvents,
  sealEvent,
  type EvidenceTier,
  type MemoryEvent,
  type MemoryEventInput,
  type MemoryProfile,
  type MemoryStore,
  type Principal,
} from '@bike4mind/memory';
import { decryptFact, encryptFact, type KeyProvider, type SealedFact } from './factCipher';

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
    ownerUserId: string
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
  input: MemoryEventInput
): Promise<MemoryEvent> {
  // Encrypt the fact once (outside the retry loop): the ciphertext is what we persist, never the
  // plaintext, so destroying the key later renders it - and any backup of it - unreadable.
  let sealedFact: SealedFact | undefined;
  if (input.fact !== undefined) {
    const dek = await keys.getOrCreateDek(input.principal, ownerUserId);
    sealedFact = encryptFact(dek, input.fact);
  }

  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    const head = await repo.head(input.principal.kind, input.principal.id);
    const sealed = sealEvent(head?.hash ?? null, input);
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
  return {
    principal: { kind: d.principalKind, id: d.principalId },
    kind: d.kind,
    subject: d.subject,
    fact,
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
export function createLedgerMemoryStore(deps: {
  ledger: Pick<LedgerRepo, 'listChain'>;
  keys: Pick<KeyProvider, 'getDek'>;
  ownerUserId: string;
  now?: string;
}): MemoryStore {
  return {
    async readProfile(principal: Principal): Promise<MemoryProfile | null> {
      const docs = await deps.ledger.listChain(principal.kind, principal.id, deps.ownerUserId);
      if (docs.length === 0) return null;
      const dek = await deps.keys.getDek(principal);
      const chain = docs.map(d => toMemoryEvent(d, dek));
      const beliefs = foldEvents(chain, { now: deps.now ?? new Date().toISOString() });
      return { principal, beliefs };
    },
  };
}

/**
 * Delete a principal's memory (crypto-shred): destroy its data-encryption key so every fact -
 * including any in DB backups - becomes permanently unreadable, then clear the payloads and mark the
 * chain shredded. The hash chain is untouched, so it still verifies; the beliefs fold to redactions.
 * Returns the number of events shredded.
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
