import { randomBytes } from 'node:crypto';
import type { IMemoryLedgerEvent } from '@bike4mind/database';
import type { Principal } from '@bike4mind/memory';
import type { LedgerRepo } from '../../ledgerMemoryStore';
import type { KeyProvider } from '../../factCipher';

/**
 * The in-memory ledger + keyring doubles the memory suites share.
 *
 * Shared rather than copied because both halves model a RULE, not just a shape - (principal, seq)
 * uniqueness, the withEmbeddings projection, and the key tombstone - and a second copy that drifted
 * would go on passing while testing something the real system does not do. The tombstone in
 * particular is the whole reason the fence is testable at all (see `makeFakeKeyring`).
 */

/** In-memory fake ledger: enforces (principal, seq) uniqueness and can force N leading conflicts. */
export function makeFakeLedger(opts: { failFirst?: number } = {}) {
  const store: IMemoryLedgerEvent[] = [];
  let fails = opts.failFirst ?? 0;
  const repo: LedgerRepo = {
    async head(pk, pid) {
      const chain = store.filter(e => e.principalKind === pk && e.principalId === pid).sort((a, b) => a.seq - b.seq);
      const last = chain[chain.length - 1];
      return last ? { hash: last.hash, seq: last.seq } : null;
    },
    async tryInsert(ev) {
      if (fails > 0) {
        fails--;
        return null; // simulate a concurrent append taking this seq
      }
      const clash = store.some(
        e => e.principalKind === ev.principalKind && e.principalId === ev.principalId && e.seq === ev.seq
      );
      if (clash) return null;
      const doc = { ...ev, id: `${ev.principalId}:${ev.seq}` } as IMemoryLedgerEvent;
      store.push(doc);
      return doc;
    },
    async listChain(pk, pid, owner, options) {
      const chain = store
        .filter(e => e.principalKind === pk && e.principalId === pid && e.ownerUserId === owner)
        .sort((a, b) => a.seq - b.seq);
      // Mirror the real projection: with embeddings excluded, the ciphertext genuinely is not there.
      // A fake that quietly returned it anyway would let a two-pass bug pass as a green test.
      if (options?.withEmbeddings === false) {
        return chain.map(
          ({ embeddingCipher: _c, embeddingIv: _i, embeddingTag: _t, ...rest }) => rest as IMemoryLedgerEvent
        );
      }
      return chain;
    },
    async listEmbeddings(pk, pid, owner, hashes) {
      return store.filter(
        e =>
          e.principalKind === pk &&
          e.principalId === pid &&
          e.ownerUserId === owner &&
          hashes.includes(e.hash) &&
          Boolean(e.embeddingCipher)
      );
    },
    async markShredded(pk, pid, owner) {
      return shredWhere(store, e => e.principalKind === pk && e.principalId === pid && e.ownerUserId === owner);
    },
    async markSubjectShredded(pk, pid, owner, subject) {
      // The belief id IS the stored subject HMAC, matched directly and never re-hashed - mirroring
      // the repository, so a caller that re-hashed before calling would shred nothing here too.
      return shredWhere(
        store,
        e => e.principalKind === pk && e.principalId === pid && e.ownerUserId === owner && e.subject === subject
      );
    },
    async markSourceShredded(pk, pid, owner, source) {
      // Exact string match on a `sources` entry, like the repository - which is what lets a
      // prefixed provenance ref work as a shred key without any special handling.
      return shredWhere(
        store,
        e =>
          e.principalKind === pk &&
          e.principalId === pid &&
          e.ownerUserId === owner &&
          Boolean(e.sources?.includes(source))
      );
    },
  };
  return { repo, store };
}

/**
 * Redact every matching event in place and return how many. Shared by the three shred methods
 * because the FIELDS cleared are the contract - a double that redacted the plaintext but left the
 * ciphertext would make a half-done shred look complete.
 */
function shredWhere(store: IMemoryLedgerEvent[], match: (e: IMemoryLedgerEvent) => boolean): number {
  let n = 0;
  for (const e of store) {
    if (!match(e) || e.shredded) continue;
    e.shredded = true;
    delete e.fact;
    delete e.factCipher;
    delete e.factIv;
    delete e.factTag;
    delete e.embeddingCipher;
    delete e.embeddingIv;
    delete e.embeddingTag;
    n += 1;
  }
  return n;
}

/** A key provider backed by an in-memory keyring, using the real cipher so encryption is exercised. */
export function makeFakeKeyring() {
  const keys = new Map<string, Buffer>();
  // Models the TOMBSTONE the real keyring leaves: a destroyed key is remembered with the time it died,
  // not forgotten. A fake that merely deleted the entry would re-mint on the next append and could
  // never observe the fence at all - which is exactly the bug the fence exists to stop.
  const destroyed = new Map<string, Date>();
  const k = (p: Principal) => `${p.kind}:${p.id}`;
  const provider: KeyProvider = {
    async getOrCreateDek(p, _ownerUserId, startedAt) {
      const existing = keys.get(k(p));
      if (existing) return existing;
      const tombstone = destroyed.get(k(p));
      // `>=`, matching the repository: a same-millisecond collision is refused rather than let
      // through, because the asymmetric cost of being wrong runs one way only.
      if (tombstone && tombstone >= startedAt) return null;
      destroyed.delete(k(p));
      const dek = randomBytes(32);
      keys.set(k(p), dek);
      return dek;
    },
    async getDek(p) {
      return keys.get(k(p)) ?? null;
    },
    async destroyDek(p, at = new Date()) {
      keys.delete(k(p));
      destroyed.set(k(p), at);
    },
  };
  return { provider, keys, destroyed };
}
