import { describe, it, expect, beforeEach } from 'vitest';
import { LAKE_MEMORY_FINDING_SOURCE_PREFIX } from '@bike4mind/common';
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

  it('accepts a lake-kind principal chain (schema enum admits the new principal)', async () => {
    // The whole point of the foundation: a data lake is a first-class memory principal. Before the
    // enum change this insert threw on validation; it must now persist and read back like any chain.
    const inserted = await memoryLedgerRepository.tryInsert(
      sealedEvent({ principalKind: 'lake', principalId: 'lake:corpus', ownerUserId: 'owner1', seq: 0, hash: 'L0' })
    );
    expect(inserted).not.toBeNull();
    expect(await memoryLedgerRepository.head('lake', 'lake:corpus')).toEqual({ hash: 'L0', seq: 0 });
    expect((await memoryLedgerRepository.listChain('lake', 'lake:corpus', 'owner1')).map(e => e.hash)).toEqual(['L0']);
  });

  it('rejects an unknown principalKind (enum enforcement intact)', async () => {
    // tryInsert only swallows the seq-collision 11000; a validation error must still propagate, so a
    // bogus kind cannot slip into the chain. Guards the enum against a silent widening.
    await expect(
      // @ts-expect-error - deliberately invalid value to prove the enum still enforces
      memoryLedgerRepository.tryInsert(sealedEvent({ principalKind: 'bogus', seq: 0, hash: 'x' }))
    ).rejects.toThrow(/enum|validation/i);
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

  it('markSubjectShredded shreds ONE belief and leaves the others intact', async () => {
    // The "delete this memory" action. Shredding one subject must not touch the user's other beliefs -
    // and, unlike a whole-principal shred, it never destroys the key, so everything else stays readable.
    await memoryLedgerRepository.tryInsert(
      sealedEvent({ seq: 0, hash: 'h0', subject: 'color', factCipher: 'c1', factIv: 'i1', factTag: 't1' })
    );
    await memoryLedgerRepository.tryInsert(
      sealedEvent({ seq: 1, hash: 'h1', prevHash: 'h0', subject: 'job', factCipher: 'c2', factIv: 'i2', factTag: 't2' })
    );

    const n = await memoryLedgerRepository.markSubjectShredded('user', 'u1', 'u1', 'color');
    expect(n).toBe(1);

    const chain = await memoryLedgerRepository.listChain('user', 'u1', 'u1');
    const color = chain.find(e => e.subject === 'color');
    const job = chain.find(e => e.subject === 'job');
    expect(color?.shredded).toBe(true);
    expect(color?.factCipher).toBeUndefined(); // its fact is gone
    expect(job?.shredded).toBeFalsy(); // the other belief is untouched
    expect(job?.factCipher).toBe('c2'); // still readable
  });

  it('markSubjectShredded is a no-op for a subject that does not exist', async () => {
    await memoryLedgerRepository.tryInsert(sealedEvent({ seq: 0, hash: 'h0', subject: 'color' }));
    const n = await memoryLedgerRepository.markSubjectShredded('user', 'u1', 'u1', 'no-such-subject');
    expect(n).toBe(0);
  });

  it('markSourceShredded shreds every fact from ONE source document, leaving the rest readable', async () => {
    // What makes permanently deleting a lake document reach the beliefs that document produced: a
    // lake's key cannot be destroyed for one file, so the scope is the source stamp instead.
    await memoryLedgerRepository.tryInsert(
      sealedEvent({
        seq: 0,
        hash: 'h0',
        subject: 'a',
        sources: ['doc-1'],
        factCipher: 'c1',
        factIv: 'i1',
        factTag: 't1',
      })
    );
    await memoryLedgerRepository.tryInsert(
      sealedEvent({
        seq: 1,
        hash: 'h1',
        prevHash: 'h0',
        subject: 'b',
        sources: ['doc-1'],
        factCipher: 'c2',
        factIv: 'i2',
        factTag: 't2',
      })
    );
    await memoryLedgerRepository.tryInsert(
      sealedEvent({
        seq: 2,
        hash: 'h2',
        prevHash: 'h1',
        subject: 'c',
        sources: ['doc-2'],
        factCipher: 'c3',
        factIv: 'i3',
        factTag: 't3',
      })
    );

    const n = await memoryLedgerRepository.markSourceShredded('user', 'u1', 'u1', 'doc-1');
    expect(n).toBe(2);

    const chain = await memoryLedgerRepository.listChain('user', 'u1', 'u1');
    expect(
      chain
        .filter(e => e.shredded)
        .map(e => e.subject)
        .sort()
    ).toEqual(['a', 'b']);
    expect(chain.find(e => e.subject === 'c')?.factCipher).toBe('c3');
  });

  it('markSourceShredded is a no-op for a document that contributed nothing', async () => {
    await memoryLedgerRepository.tryInsert(sealedEvent({ seq: 0, hash: 'h0', subject: 'a', sources: ['doc-1'] }));
    const n = await memoryLedgerRepository.markSourceShredded('user', 'u1', 'u1', 'doc-9');
    expect(n).toBe(0);
  });

  describe('aggregateLakeMemoryCoverage', () => {
    it('reports factCount, sourceDocumentCount and lastBuiltAt for a lake with a surviving chain', async () => {
      await memoryLedgerRepository.tryInsert(
        sealedEvent({
          principalKind: 'lake',
          principalId: 'lake:acme',
          ownerUserId: 'owner1',
          seq: 0,
          hash: 'L0',
          subject: 'fact-a',
          sources: ['doc-1'],
          at: '2026-09-01T00:00:00.000Z',
        })
      );
      await memoryLedgerRepository.tryInsert(
        sealedEvent({
          principalKind: 'lake',
          principalId: 'lake:acme',
          ownerUserId: 'owner1',
          seq: 1,
          hash: 'L1',
          prevHash: 'L0',
          subject: 'fact-b',
          sources: ['doc-1', 'doc-2'],
          at: '2026-09-02T00:00:00.000Z',
        })
      );

      const coverage = await memoryLedgerRepository.aggregateLakeMemoryCoverage('lake', 'lake:acme', 'owner1');
      expect(coverage.factCount).toBe(2);
      expect(coverage.sourceDocumentCount).toBe(2); // doc-1 and doc-2, deduplicated across events
      expect(coverage.lastBuiltAt).toBe('2026-09-02T00:00:00.000Z');
    });

    it('reports zero coverage for a lake whose ledger is entirely shredded (a purged lake has no profile)', async () => {
      await memoryLedgerRepository.tryInsert(
        sealedEvent({
          principalKind: 'lake',
          principalId: 'lake:purged',
          ownerUserId: 'owner1',
          seq: 0,
          hash: 'P0',
          subject: 'fact-a',
          sources: ['doc-1'],
        })
      );
      await memoryLedgerRepository.markShredded('lake', 'lake:purged', 'owner1');

      const coverage = await memoryLedgerRepository.aggregateLakeMemoryCoverage('lake', 'lake:purged', 'owner1');
      expect(coverage).toEqual({ lastBuiltAt: null, factCount: 0, sourceDocumentCount: 0 });
    });

    it('counts DOCUMENTS only, never a provenance ref, so the health card is not inflated (#3049)', async () => {
      // A curator-resolution belief names the finding it was decided on alongside the documents
      // involved. `sourceDocumentCount` is a raw distinct count of the `sources` union, so without
      // the prefix filter the finding ref would be counted as if it were a source document - a
      // number a human reads off the lake-memory health card, wrong by one per ruling and with
      // nothing anywhere to flag it.
      await memoryLedgerRepository.tryInsert(
        sealedEvent({
          principalKind: 'lake',
          principalId: 'lake:prov',
          ownerUserId: 'owner1',
          seq: 0,
          hash: 'V0',
          subject: 'fact-a',
          sources: ['doc-1', 'doc-2', `${LAKE_MEMORY_FINDING_SOURCE_PREFIX}finding-7`],
          at: '2026-09-01T00:00:00.000Z',
        })
      );

      const coverage = await memoryLedgerRepository.aggregateLakeMemoryCoverage('lake', 'lake:prov', 'owner1');
      expect(coverage.sourceDocumentCount).toBe(2);
      // The belief itself still counts as a fact - only its provenance ref is excluded.
      expect(coverage.factCount).toBe(1);
    });

    it('reports zero source documents for a belief carrying nothing but a provenance ref', async () => {
      // Not a shape this codebase writes (the belief always carries its finding's documents too),
      // but the filter must not fall back to counting the ref when it is the only entry - that
      // would resurrect the inflation for exactly the edge case nobody looks at.
      await memoryLedgerRepository.tryInsert(
        sealedEvent({
          principalKind: 'lake',
          principalId: 'lake:provonly',
          ownerUserId: 'owner1',
          seq: 0,
          hash: 'VO0',
          subject: 'fact-a',
          sources: [`${LAKE_MEMORY_FINDING_SOURCE_PREFIX}finding-9`],
        })
      );

      const coverage = await memoryLedgerRepository.aggregateLakeMemoryCoverage('lake', 'lake:provonly', 'owner1');
      expect(coverage.sourceDocumentCount).toBe(0);
      expect(coverage.factCount).toBe(1);
    });

    it('counts a fact whose sources array is EMPTY, without the $reduce swallowing the event', async () => {
      // The empty-input branch of the `$reduce` that unions the sources arrays. Distinct from the
      // provenance-only case above: there the array has an entry the `$filter` rejects, here there
      // is nothing to fold at all. An aggregation that mishandled it would drop the event from
      // `factCount` too, under-reporting a lake's memory rather than over-reporting its documents.
      await memoryLedgerRepository.tryInsert(
        sealedEvent({
          principalKind: 'lake',
          principalId: 'lake:nosources',
          ownerUserId: 'owner1',
          seq: 0,
          hash: 'VE0',
          subject: 'fact-a',
          sources: [],
        })
      );

      const coverage = await memoryLedgerRepository.aggregateLakeMemoryCoverage('lake', 'lake:nosources', 'owner1');
      expect(coverage.sourceDocumentCount).toBe(0);
      expect(coverage.factCount).toBe(1);
    });

    it('reports zero coverage for a lake with no ledger events at all', async () => {
      const coverage = await memoryLedgerRepository.aggregateLakeMemoryCoverage('lake', 'lake:none', 'owner1');
      expect(coverage).toEqual({ lastBuiltAt: null, factCount: 0, sourceDocumentCount: 0 });
    });

    it('excludes a shredded event from the count while a surviving event on the same principal still counts', async () => {
      await memoryLedgerRepository.tryInsert(
        sealedEvent({
          principalKind: 'lake',
          principalId: 'lake:mixed',
          ownerUserId: 'owner1',
          seq: 0,
          hash: 'M0',
          subject: 'fact-shredded',
          sources: ['doc-shredded'],
          at: '2026-09-01T00:00:00.000Z',
          shredded: true,
        })
      );
      await memoryLedgerRepository.tryInsert(
        sealedEvent({
          principalKind: 'lake',
          principalId: 'lake:mixed',
          ownerUserId: 'owner1',
          seq: 1,
          hash: 'M1',
          prevHash: 'M0',
          subject: 'fact-surviving',
          sources: ['doc-surviving'],
          at: '2026-09-02T00:00:00.000Z',
        })
      );

      const coverage = await memoryLedgerRepository.aggregateLakeMemoryCoverage('lake', 'lake:mixed', 'owner1');
      expect(coverage.factCount).toBe(1);
      expect(coverage.sourceDocumentCount).toBe(1);
      expect(coverage.lastBuiltAt).toBe('2026-09-02T00:00:00.000Z');
    });

    it('does not let an unrelated principalId or principalKind leak into the aggregate', async () => {
      await memoryLedgerRepository.tryInsert(
        sealedEvent({
          principalKind: 'lake',
          principalId: 'lake:target',
          ownerUserId: 'owner1',
          seq: 0,
          hash: 'T0',
          subject: 'fact-target',
          sources: ['doc-target'],
          at: '2026-09-01T00:00:00.000Z',
        })
      );
      // A different lake principal - must not contribute to lake:target's aggregate.
      await memoryLedgerRepository.tryInsert(
        sealedEvent({
          principalKind: 'lake',
          principalId: 'lake:other',
          ownerUserId: 'owner1',
          seq: 0,
          hash: 'O0',
          subject: 'fact-other',
          sources: ['doc-other'],
          at: '2026-09-05T00:00:00.000Z',
        })
      );
      // Same principalId, but a different principalKind - must not contribute either.
      await memoryLedgerRepository.tryInsert(
        sealedEvent({
          principalKind: 'user',
          principalId: 'lake:target',
          ownerUserId: 'owner1',
          seq: 0,
          hash: 'U0',
          subject: 'fact-user',
          sources: ['doc-user'],
          at: '2026-09-06T00:00:00.000Z',
        })
      );

      const coverage = await memoryLedgerRepository.aggregateLakeMemoryCoverage('lake', 'lake:target', 'owner1');
      expect(coverage.factCount).toBe(1);
      expect(coverage.sourceDocumentCount).toBe(1);
      expect(coverage.lastBuiltAt).toBe('2026-09-01T00:00:00.000Z');
    });
  });

  describe('distinctSurvivingPrincipalIds', () => {
    it('returns only principalIds of the given kind that have at least one non-shredded event', async () => {
      await memoryLedgerRepository.tryInsert(
        sealedEvent({ principalKind: 'lake', principalId: 'lake:has-facts', ownerUserId: 'owner1', seq: 0, hash: 'A0' })
      );
      await memoryLedgerRepository.tryInsert(
        sealedEvent({
          principalKind: 'lake',
          principalId: 'lake:all-shredded',
          ownerUserId: 'owner1',
          seq: 0,
          hash: 'B0',
        })
      );
      await memoryLedgerRepository.markShredded('lake', 'lake:all-shredded', 'owner1');
      // A different principalKind must not leak into the 'lake' result.
      await memoryLedgerRepository.tryInsert(
        sealedEvent({ principalKind: 'user', principalId: 'lake:has-facts', ownerUserId: 'owner1', seq: 0, hash: 'C0' })
      );

      const ids = await memoryLedgerRepository.distinctSurvivingPrincipalIds('lake');
      expect(ids).toEqual(['lake:has-facts']);
    });

    it('returns empty when every lake chain has been fully shredded', async () => {
      await memoryLedgerRepository.tryInsert(
        sealedEvent({ principalKind: 'lake', principalId: 'lake:purged', ownerUserId: 'owner1', seq: 0, hash: 'D0' })
      );
      await memoryLedgerRepository.markShredded('lake', 'lake:purged', 'owner1');

      expect(await memoryLedgerRepository.distinctSurvivingPrincipalIds('lake')).toEqual([]);
    });

    it('lists a principalId once even when multiple surviving events share it', async () => {
      await memoryLedgerRepository.tryInsert(
        sealedEvent({
          principalKind: 'lake',
          principalId: 'lake:multi-event',
          ownerUserId: 'owner1',
          seq: 0,
          hash: 'E0',
        })
      );
      await memoryLedgerRepository.tryInsert(
        sealedEvent({
          principalKind: 'lake',
          principalId: 'lake:multi-event',
          ownerUserId: 'owner1',
          seq: 1,
          hash: 'E1',
          prevHash: 'E0',
        })
      );

      const ids = await memoryLedgerRepository.distinctSurvivingPrincipalIds('lake');
      expect(ids).toEqual(['lake:multi-event']);
    });
  });

  describe('rewriteEmbedding', () => {
    const vec = { cipher: 'vc', iv: 'vi', tag: 'vt', model: 'current' };

    it('rewrites only the embedding fields, leaving the chain-bound fields alone', async () => {
      await memoryLedgerRepository.tryInsert(sealedEvent({ hash: 'h0', commitment: 'c0', salt: 's0' }));

      expect(await memoryLedgerRepository.rewriteEmbedding('user', 'u1', 'u1', 'h0', vec)).toBe(1);

      const doc = await MemoryLedgerEventModel.findOne({ hash: 'h0' }).lean();
      expect(doc).toMatchObject({ embeddingCipher: 'vc', embeddingModel: 'current', commitment: 'c0', seq: 0 });
    });

    it('never writes a vector onto a shredded event', async () => {
      await memoryLedgerRepository.tryInsert(sealedEvent({ hash: 'h0', sources: ['doc-1'] }));
      await memoryLedgerRepository.markSourceShredded('user', 'u1', 'u1', 'doc-1');

      expect(await memoryLedgerRepository.rewriteEmbedding('user', 'u1', 'u1', 'h0', vec)).toBe(0);
      const doc = await MemoryLedgerEventModel.findOne({ hash: 'h0' }).lean();
      expect(doc?.embeddingCipher).toBeUndefined();
    });
  });

  describe('listPrincipalsNeedingVectors', () => {
    const CURRENT = 'space-v2';
    const VECTORLESS_INDEX = 'memory_ledger_vectorless_candidates';
    const STALE_INDEX = 'memory_ledger_stale_vector_candidates';
    const at = (kind: IMemoryLedgerEvent['principalKind'], id: string, owner: string, seq = 0) =>
      sealedEvent({ principalKind: kind, principalId: id, ownerUserId: owner, seq, hash: `${kind}:${id}:${seq}` });

    const repairPipeline = (
      vectorMatch: Record<string, unknown>,
      after?: { principalKind: string; principalId: string; ownerUserId: string }
    ) => {
      const match: Record<string, unknown>[] = [
        { shredded: { $ne: true }, kind: { $in: ['assert', 'affirm'] } },
        { $or: [{ factCipher: { $nin: [null, ''] } }, { fact: { $nin: [null, ''] } }] },
        vectorMatch,
      ];
      if (after) {
        match.push({
          $or: [
            { principalKind: { $gt: after.principalKind } },
            { principalKind: after.principalKind, principalId: { $gt: after.principalId } },
            {
              principalKind: after.principalKind,
              principalId: after.principalId,
              ownerUserId: { $gt: after.ownerUserId },
            },
          ],
        });
      }
      return [
        { $match: { $and: match } },
        { $project: { _id: 0, principalKind: 1, principalId: 1, ownerUserId: 1 } },
        {
          $group: {
            _id: { principalKind: '$principalKind', principalId: '$principalId', ownerUserId: '$ownerUserId' },
          },
        },
        { $sort: { '_id.principalKind': 1 as const, '_id.principalId': 1 as const, '_id.ownerUserId': 1 as const } },
        { $limit: 25 },
      ];
    };

    it('finds vectorless and stale-stamped chains of every kind, distinct and sorted', async () => {
      await memoryLedgerRepository.tryInsert(at('user', 'u1', 'u1'));
      await memoryLedgerRepository.tryInsert(at('user', 'u1', 'u1', 1));
      await memoryLedgerRepository.tryInsert(at('lake', 'lake:a', 'owner1'));
      await memoryLedgerRepository.tryInsert({
        ...at('agent', 'ag1', 'u9'),
        fact: undefined,
        factCipher: 'c',
        factIv: 'i',
        factTag: 't',
        embeddingCipher: 'old',
        embeddingModel: 'ada-002',
      });

      expect(await memoryLedgerRepository.listPrincipalsNeedingVectors(CURRENT, { limit: 10 })).toEqual([
        { principalKind: 'agent', principalId: 'ag1', ownerUserId: 'u9' },
        { principalKind: 'lake', principalId: 'lake:a', ownerUserId: 'owner1' },
        { principalKind: 'user', principalId: 'u1', ownerUserId: 'u1' },
      ]);
    });

    it('skips shredded, retract, factless and already-current events', async () => {
      await memoryLedgerRepository.tryInsert({ ...at('user', 'shred', 'shred'), shredded: true });
      await memoryLedgerRepository.tryInsert({ ...at('user', 'retract', 'retract'), kind: 'retract' });
      await memoryLedgerRepository.tryInsert({ ...at('user', 'nofact', 'nofact'), fact: '' });
      await memoryLedgerRepository.tryInsert({
        ...at('user', 'done', 'done'),
        embeddingCipher: 'v',
        embeddingModel: CURRENT,
      });

      expect(await memoryLedgerRepository.listPrincipalsNeedingVectors(CURRENT, { limit: 10 })).toEqual([]);
    });

    it('finds a current-stamped event whose vector ciphertext is missing', async () => {
      await memoryLedgerRepository.tryInsert({ ...at('agent', 'stamp-only', 'owner'), embeddingModel: CURRENT });

      expect(await memoryLedgerRepository.listPrincipalsNeedingVectors(CURRENT, { limit: 10 })).toEqual([
        { principalKind: 'agent', principalId: 'stamp-only', ownerUserId: 'owner' },
      ]);
    });

    it('pages by keyset cursor across a kind boundary and honours limit', async () => {
      await memoryLedgerRepository.tryInsert(at('lake', 'lake:a', 'o1'));
      await memoryLedgerRepository.tryInsert(at('lake', 'lake:b', 'o1'));
      await memoryLedgerRepository.tryInsert(at('user', 'u1', 'u1'));

      const first = await memoryLedgerRepository.listPrincipalsNeedingVectors(CURRENT, { limit: 2 });
      expect(first.map(p => p.principalId)).toEqual(['lake:a', 'lake:b']);

      const rest = await memoryLedgerRepository.listPrincipalsNeedingVectors(CURRENT, { after: first[1], limit: 2 });
      expect(rest.map(p => p.principalId)).toEqual(['u1']);
    });

    it('uses the partial repair indexes for initial and resumed pages', async () => {
      await MemoryLedgerEventModel.collection.insertMany(
        Array.from({ length: 2_000 }, (_, i) => ({
          ...at('user', `done-${i}`, 'owner'),
          embeddingCipher: 'vector',
          embeddingModel: CURRENT,
        }))
      );
      await memoryLedgerRepository.tryInsert(at('lake', 'needs-vector', 'owner'));
      await memoryLedgerRepository.tryInsert({
        ...at('user', 'stale-vector', 'owner'),
        embeddingCipher: 'vector',
        embeddingModel: 'space-v1',
      });

      const declared = new Map(MemoryLedgerEventModel.schema.indexes().map(index => [index[1]?.name, index]));
      expect(declared.get(VECTORLESS_INDEX)).toEqual([
        { embeddingCipher: 1, principalKind: 1, principalId: 1, ownerUserId: 1 },
        { name: VECTORLESS_INDEX, partialFilterExpression: { kind: { $in: ['assert', 'affirm'] } }, background: true },
      ]);
      expect(declared.get(STALE_INDEX)).toEqual([
        { embeddingModel: 1, principalKind: 1, principalId: 1, ownerUserId: 1 },
        { name: STALE_INDEX, partialFilterExpression: { kind: { $in: ['assert', 'affirm'] } }, background: true },
      ]);

      for (const after of [undefined, { principalKind: 'lake', principalId: 'needs-vector', ownerUserId: 'owner' }]) {
        for (const [vectorMatch, indexName] of [
          [{ embeddingCipher: { $in: [null, ''] } }, VECTORLESS_INDEX],
          [{ embeddingModel: { $ne: CURRENT } }, STALE_INDEX],
        ] as const) {
          const plan = await MemoryLedgerEventModel.collection
            .aggregate(repairPipeline(vectorMatch, after))
            .explain('queryPlanner');
          const winning = JSON.stringify(plan);
          expect(winning).toContain(`\"indexName\":\"${indexName}\"`);
          expect(winning).not.toContain('COLLSCAN');
        }
      }
    });
  });
});
