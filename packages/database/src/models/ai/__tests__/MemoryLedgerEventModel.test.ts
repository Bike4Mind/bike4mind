import { describe, it, expect, beforeEach } from 'vitest';
import { setupMongoTest } from '../../../__test__/utils';
import MemoryLedgerEventModel, { memoryLedgerRepository, type IMemoryLedgerEvent } from '../MemoryLedgerEventModel';

function sealedEvent(over: Partial<IMemoryLedgerEvent>): Omit<IMemoryLedgerEvent, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    principalKind: 'user',
    principalId: 'u1',
    ownerUserId: 'u1',
    seq: 0,
    kind: 'assert',
    subject: 'role',
    fact: 'a fact',
    evidenceTier: 'engineering-proxy',
    at: '2026-07-01T00:00:00.000Z',
    sources: [],
    hash: 'h0',
    prevHash: null,
    ...over,
  };
}

describe('MemoryLedgerRepository', () => {
  setupMongoTest();

  // setupMongoTest drops the DB (and its indexes) in its beforeEach; re-ensure the unique index
  // here so the concurrency test actually enforces it. Registered after, so it runs after the drop.
  beforeEach(async () => {
    await MemoryLedgerEventModel.ensureIndexes();
  });

  it('head is null on an empty chain, then tracks the highest seq', async () => {
    expect(await memoryLedgerRepository.head('user', 'u1')).toBeNull();
    await memoryLedgerRepository.tryInsert(sealedEvent({ seq: 0, hash: 'h0' }));
    await memoryLedgerRepository.tryInsert(sealedEvent({ seq: 1, hash: 'h1', prevHash: 'h0' }));
    expect(await memoryLedgerRepository.head('user', 'u1')).toEqual({ hash: 'h1', seq: 1 });
  });

  it('tryInsert returns the stored event, and null on a seq collision (race signal)', async () => {
    const first = await memoryLedgerRepository.tryInsert(sealedEvent({ seq: 0, hash: 'h0' }));
    expect(first).not.toBeNull();
    // A second insert at the same (principal, seq) is the concurrent-append collision.
    const collided = await memoryLedgerRepository.tryInsert(sealedEvent({ seq: 0, hash: 'h0-b' }));
    expect(collided).toBeNull();
  });

  it('listChain returns a principal chain in seq order, owner-scoped', async () => {
    await memoryLedgerRepository.tryInsert(sealedEvent({ seq: 1, hash: 'h1', prevHash: 'h0' }));
    await memoryLedgerRepository.tryInsert(sealedEvent({ seq: 0, hash: 'h0' }));
    const chain = await memoryLedgerRepository.listChain('user', 'u1', 'u1');
    expect(chain.map(e => e.seq)).toEqual([0, 1]);
  });

  it('listChain returns empty for a chain the caller does not own (no existence leak)', async () => {
    await memoryLedgerRepository.tryInsert(sealedEvent({ principalId: 'u1', ownerUserId: 'u1' }));
    expect(await memoryLedgerRepository.listChain('user', 'u1', 'someone-else')).toEqual([]);
  });

  it('isolates chains by principal', async () => {
    await memoryLedgerRepository.tryInsert(sealedEvent({ principalId: 'u1', ownerUserId: 'u1', seq: 0, hash: 'a' }));
    await memoryLedgerRepository.tryInsert(sealedEvent({ principalId: 'u2', ownerUserId: 'u2', seq: 0, hash: 'b' }));
    expect((await memoryLedgerRepository.listChain('user', 'u1', 'u1')).map(e => e.hash)).toEqual(['a']);
    expect(await memoryLedgerRepository.head('user', 'u2')).toEqual({ hash: 'b', seq: 0 });
  });

  it('markShredded clears the embedding ciphertext along with the fact', async () => {
    // The embedding is a semantic image of the fact (inversion can partially reconstruct the source
    // text), so a shred that cleared the fact but left the embedding behind would leave a
    // recoverable fingerprint of the very content it destroyed.
    await memoryLedgerRepository.tryInsert(
      sealedEvent({
        seq: 0,
        hash: 'h0',
        fact: undefined,
        factCipher: 'fc',
        factIv: 'fi',
        factTag: 'ft',
        embeddingCipher: 'ec',
        embeddingIv: 'ei',
        embeddingTag: 'et',
      })
    );

    const n = await memoryLedgerRepository.markShredded('user', 'u1', 'u1');
    expect(n).toBe(1);

    const [doc] = await memoryLedgerRepository.listChain('user', 'u1', 'u1');
    expect(doc.shredded).toBe(true);
    expect(doc.factCipher).toBeUndefined();
    expect(doc.embeddingCipher).toBeUndefined();
    expect(doc.embeddingIv).toBeUndefined();
    expect(doc.embeddingTag).toBeUndefined();
  });
});
