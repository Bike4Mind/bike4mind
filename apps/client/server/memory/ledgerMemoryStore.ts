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
  ownerUserId: string,
  input: MemoryEventInput
): Promise<MemoryEvent> {
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
      fact: sealed.fact,
      evidenceTier: sealed.evidenceTier,
      salience: sealed.salience,
      at: sealed.at,
      sources: sealed.sources ?? [],
      hash: sealed.hash,
      prevHash: sealed.prevHash,
    });
    if (stored) return sealed;
  }
  throw new Error('memory ledger append: exceeded retry budget under concurrent contention');
}

/** Rehydrate a stored document into the core's `MemoryEvent` shape (dropping the persistence scope). */
function toMemoryEvent(d: IMemoryLedgerEvent): MemoryEvent {
  return {
    principal: { kind: d.principalKind, id: d.principalId },
    kind: d.kind,
    subject: d.subject,
    fact: d.fact,
    evidenceTier: d.evidenceTier as EvidenceTier | undefined,
    salience: d.salience,
    at: d.at,
    sources: d.sources,
    hash: d.hash,
    prevHash: d.prevHash,
  };
}

/**
 * A persisted-ledger MemoryStore, owner-scoped. Lists the principal's chain (restricted to
 * `ownerUserId`, so a not-owned or empty chain both read as null - no existence leak) and folds it
 * to a live profile, computing ACT-R salience as of `now`. This is the store that lets real writes
 * surface through GET /api/memory/:kind/:id; it is composed ahead of the snapshot adapters, so a
 * principal with no ledger events falls through to them unchanged.
 */
export function createLedgerMemoryStore(deps: {
  ledger: Pick<LedgerRepo, 'listChain'>;
  ownerUserId: string;
  now?: string;
}): MemoryStore {
  return {
    async readProfile(principal: Principal): Promise<MemoryProfile | null> {
      const docs = await deps.ledger.listChain(principal.kind, principal.id, deps.ownerUserId);
      if (docs.length === 0) return null;
      const chain = docs.map(toMemoryEvent);
      const beliefs = foldEvents(chain, { now: deps.now ?? new Date().toISOString() });
      return { principal, beliefs };
    },
  };
}
