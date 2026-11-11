import { describe, expect, it, vi } from 'vitest';
import { type IMemento, MementoTier, MementoType } from '@bike4mind/common';
import { verifyMemoryExport } from '@bike4mind/memory';
import { appendMemoryEvent } from './ledgerMemoryStore';
import { exportPrincipalMemory } from './exportPrincipalMemory';
import { makeFakeLedger, makeFakeKeyring } from './__tests__/utils/ledgerDoubles';

const principal = { kind: 'user' as const, id: 'u1' };
const row = (id: string, tier: MementoTier): IMemento & { id: string } => ({
  id,
  userId: 'u1',
  sessionId: null,
  type: MementoType.INSIGHT,
  tier,
  weight: 10,
  summary: id,
  fullContent: `content ${id}`,
  lastAccessedAt: new Date('2026-07-01'),
  isArchived: tier === MementoTier.COLD,
});

describe('exportPrincipalMemory', () => {
  it('exports the decrypted complete ledger, redactions, and all v1 tiers without ciphertext', async () => {
    const { repo, store } = makeFakeLedger();
    const { provider } = makeFakeKeyring();
    await appendMemoryEvent(
      repo,
      provider,
      'u1',
      { principal, kind: 'assert', subject: 'role', fact: 'Engineer', at: '2026-07-01T00:00:00.000Z' },
      { startedAt: new Date() }
    );
    await appendMemoryEvent(
      repo,
      provider,
      'u1',
      { principal, kind: 'assert', subject: 'secret', fact: 'Do not export', at: '2026-07-02T00:00:00.000Z' },
      { startedAt: new Date() }
    );
    await repo.markSubjectShredded('user', 'u1', 'u1', store[1].subject);
    const mementos = {
      findByUserId: vi.fn(async () => [
        { ...row('a', MementoTier.HOT), embedding: Array(1536).fill(0.25), embeddingModel: 'old-model' },
        row('b', MementoTier.WARM),
        row('c', MementoTier.COLD),
      ]),
    };
    const exported = await exportPrincipalMemory({
      principal,
      ownerUserId: 'u1',
      ledger: repo,
      keys: provider,
      mementos,
      now: '2026-07-03T00:00:00.000Z',
    });
    expect(exported.events).toHaveLength(2);
    expect(exported.events[0].fact).toBe('Engineer');
    expect(exported.events[1]).not.toHaveProperty('fact');
    expect(exported.events[1]).not.toHaveProperty('salt');
    expect(JSON.stringify(exported)).not.toContain('Do not export');
    expect(JSON.stringify(exported)).not.toContain('factCipher');
    expect(exported.mementos.map(m => m.tier)).toEqual(['hot', 'warm', 'cold']);
    expect(exported.mementos[0]).not.toHaveProperty('embedding');
    expect(exported.mementos[0]).not.toHaveProperty('embeddingModel');
    expect(JSON.stringify(exported)).not.toContain('old-model');
    expect(verifyMemoryExport(exported)).toEqual({ ok: true });
    expect(verifyMemoryExport(JSON.parse(JSON.stringify(exported)))).toEqual({ ok: true });
    for (const memento of exported.mementos) expect(memento).not.toHaveProperty('metadata');
  });

  describe('memento paging', () => {
    const paddedId = (n: number) => String(n).padStart(6, '0');
    const exportWith = async (
      findByUserId: (userId: string, o: { limit: number; afterId?: string }) => Promise<never>
    ) => {
      const { repo } = makeFakeLedger();
      const { provider } = makeFakeKeyring();
      return exportPrincipalMemory({
        principal,
        ownerUserId: 'u1',
        ledger: repo,
        keys: provider,
        mementos: { findByUserId },
      });
    };

    it('exports every page in order using the previous id as the cursor', async () => {
      const all = Array.from({ length: 450 }, (_, i) => row(paddedId(i + 1), MementoTier.HOT));
      const findByUserId = vi.fn(async (_userId: string, o: { limit: number; afterId?: string }) =>
        all.filter(r => o.afterId === undefined || r.id > o.afterId).slice(0, o.limit)
      );
      const exported = await exportWith(findByUserId as never);
      expect(exported.mementos.map(m => m.id)).toEqual(all.map(r => r.id));
      expect(findByUserId.mock.calls.map(c => c[1])).toEqual([
        { limit: 200, afterId: undefined },
        { limit: 200, afterId: paddedId(200) },
        { limit: 200, afterId: paddedId(400) },
      ]);
    });

    it('rejects a page whose ids do not advance past the cursor', async () => {
      const full = Array.from({ length: 200 }, (_, i) => row(paddedId(i + 1), MementoTier.HOT));
      const findByUserId = vi
        .fn()
        .mockResolvedValueOnce(full)
        .mockResolvedValueOnce([row(paddedId(200), MementoTier.HOT)]);
      await expect(exportWith(findByUserId)).rejects.toThrow(/Invalid owner or cursor/);
    });

    it('rejects a row that belongs to another user', async () => {
      const findByUserId = vi.fn().mockResolvedValue([{ ...row('a', MementoTier.HOT), userId: 'u2' }]);
      await expect(exportWith(findByUserId)).rejects.toThrow(/Invalid owner or cursor/);
    });
  });

  it('does not query keys or mementos for a foreign user', async () => {
    const { repo } = makeFakeLedger();
    const { provider } = makeFakeKeyring();
    const spy = vi.spyOn(repo, 'listChain');
    const mementos = { findByUserId: vi.fn() };
    await expect(
      exportPrincipalMemory({ principal, ownerUserId: 'other', ledger: repo, keys: provider, mementos })
    ).rejects.toThrow(/another user/);
    expect(spy).not.toHaveBeenCalled();
    expect(mementos.findByUserId).not.toHaveBeenCalled();
  });

  it('refuses to call a user-only ledger export complete without the v1 repository', async () => {
    const { repo } = makeFakeLedger();
    const { provider } = makeFakeKeyring();
    const spy = vi.spyOn(repo, 'listChain');
    await expect(exportPrincipalMemory({ principal, ownerUserId: 'u1', ledger: repo, keys: provider })).rejects.toThrow(
      /requires a memento repository/
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('exports v1-only memory and fails closed on corrupted ledger ciphertext', async () => {
    const { repo, store } = makeFakeLedger();
    const { provider } = makeFakeKeyring();
    const mementos = { findByUserId: vi.fn(async () => [row('a', MementoTier.COLD)]) };
    const empty = await exportPrincipalMemory({ principal, ownerUserId: 'u1', ledger: repo, keys: provider, mementos });
    expect(empty.events).toEqual([]);
    expect(empty.mementos).toHaveLength(1);
    await appendMemoryEvent(
      repo,
      provider,
      'u1',
      { principal, kind: 'assert', subject: 'role', fact: 'Engineer', at: '2026-07-01T00:00:00.000Z' },
      { startedAt: new Date() }
    );
    store[0].factTag = 'invalid';
    await expect(
      exportPrincipalMemory({ principal, ownerUserId: 'u1', ledger: repo, keys: provider, mementos })
    ).rejects.toThrow(/unreadable/);
  });
});
